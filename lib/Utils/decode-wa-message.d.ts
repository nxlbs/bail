"use strict";

const { Boom } = require('@hapi/boom');
const { proto } = require('../../WAProto');
const { areJidsSameUser, isJidBroadcast, isJidGroup, isJidMetaIa, isJidNewsletter, isJidStatusBroadcast, isJidUser, isLidUser, jidNormalizedUser } = require('../WABinary');
const { unpadRandomMax16 } = require('./generics');
const { getDevice } = require('./messages');

const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node';
const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled';

const NACK_REASONS = {
    ParsingError: 487,
    UnrecognizedStanza: 488,
    UnrecognizedStanzaClass: 489,
    UnrecognizedStanzaType: 490,
    InvalidProtobuf: 491,
    InvalidHostedCompanionStanza: 493,
    MissingMessageSecret: 495,
    SignalErrorOldCounter: 496,
    MessageDeletedOnPeer: 499,
    UnhandledError: 500,
    UnsupportedAdminRevoke: 550,
    UnsupportedLIDGroup: 551,
    DBOperationFailed: 552
};

/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
function decodeMessageNode(stanza, meId, meLid) {
    let msgType;
    let chatId;
    let author;

    const msgId = stanza.attrs.id;
    const from = stanza.attrs.from;
    const participant = stanza.attrs.participant;
    const recipient = stanza.attrs.recipient;

    const isMe = (jid) => areJidsSameUser(jid, meId);
    const isMeLid = (jid) => areJidsSameUser(jid, meLid);

    if (isJidUser(from) || isLidUser(from)) {
        if (recipient && !isJidMetaIa(recipient)) {
            if (!isMe(from) && !isMeLid(from)) {
                throw new Boom('receipient present, but msg not from me', { data: stanza });
            }

            chatId = recipient;
        } else {
            chatId = from;
        }

        msgType = 'chat';
        author = from;
    } else if (isJidGroup(from)) {
        if (!participant) {
            throw new Boom('No participant in group message');
        }

        msgType = 'group';
        author = participant;
        chatId = from;
    } else if (isJidBroadcast(from)) {
        if (!participant) {
            throw new Boom('No participant in group message');
        }

        const isParticipantMe = isMe(participant);
        if (isJidStatusBroadcast(from)) {
            msgType = isParticipantMe ? 'direct_peer_status' : 'other_status';
        } else {
            msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast';
        }

        chatId = from;
        author = participant;
    } else if (isJidNewsletter(from)) {
        msgType = 'newsletter';
        chatId = from;
        author = from;
    } else {
        throw new Boom('Unknown message type', { data: stanza });
    }

    const fromMe = isJidNewsletter(from) 
        ? !!stanza.attrs?.is_sender 
        : isLidUser(from) 
            ? isMeLid(stanza.attrs.participant || stanza.attrs.from) 
            : isMe(stanza.attrs.participant || stanza.attrs.from);

    const pushname = stanza?.attrs?.notify;

    const key = {
        remoteJid: chatId,
        fromMe,
        id: msgId,
        participant,
        senderLid: stanza?.attrs?.sender_lid,
        senderPn: stanza?.attrs?.sender_pn,
        participantLid: stanza?.attrs?.participant_lid,
        newsletter_server_id: msgType === 'newsletter' ? +stanza.attrs?.server_id : undefined
    };

    const fullMessage = {
        key,
        messageTimestamp: +stanza.attrs.t,
        pushName: pushname,
        broadcast: isJidBroadcast(from),
        newsletter: isJidNewsletter(from)
    };

    if (msgType === 'newsletter') {
        fullMessage.newsletter_server_id = +stanza.attrs?.server_id;
    }

    if (key.fromMe) {
        fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK;
    }

    if (!key.fromMe) {
        fullMessage.platform = getDevice(key.id);
    }

    return {
        fullMessage,
        author,
        sender: msgType === 'chat' ? author : chatId
    };
}

function decryptMessageNode(stanza, meId, meLid, repository, logger) {
    const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid);
    return {
        fullMessage,
        category: stanza.attrs.category,
        author,
        async decrypt() {
            let decryptables = 0;
            if (Array.isArray(stanza.content)) {
                for (const { tag, attrs, content } of stanza.content) {
                    if (tag === 'verified_name' && content instanceof Uint8Array) {
                        const cert = proto.VerifiedNameCertificate.decode(content);
                        const details = proto.VerifiedNameCertificate.Details.decode(cert.details);
                        fullMessage.verifiedBizName = details.verifiedName;
                    }

                    if (tag === 'multicast' && content instanceof Uint8Array) {
                        fullMessage.multicast = true;
                    }

                    if (tag === 'meta' && content instanceof Uint8Array) {
                        fullMessage.metaInfo = {
                            targetID: attrs.target_id
                        };
                        if (attrs.target_sender_jid) {
                            fullMessage.metaInfo.targetSender = jidNormalizedUser(attrs.target_sender_jid);
                        }
                    }

                    if (tag === 'bot' && content instanceof Uint8Array) {
                        if (attrs.edit) {
                            fullMessage.botInfo = {
                                editType: attrs.edit,
                                editTargetID: attrs.edit_target_id,
                                editSenderTimestampMS: attrs.sender_timestamp_ms
                            };
                        }
                    }

                    if (tag !== 'enc' && tag !== 'plaintext') {
                        continue;
                    }

                    if (!(content instanceof Uint8Array)) {
                        continue;
                    }

                    decryptables += 1;

                    let msgBuffer;
                    try {
                        const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type;
                        switch (e2eType) {
                            case 'skmsg':
                                msgBuffer = await repository.decryptGroupMessage({
                                    group: sender,
                                    authorJid: author,
                                    msg: content
                                });
                                break;
                            case 'pkmsg':
                            case 'msg':
                                const user = isJidUser(sender) ? sender : author;
                                msgBuffer = await repository.decryptMessage({
                                    jid: user,
                                    type: e2eType,
                                    ciphertext: content
                                });
                                break;
                            case 'plaintext':
                                msgBuffer = content;
                                break;
                            default:
                                throw new Error(`Unknown e2e type: ${e2eType}`);
                        }

                        let msg = proto.Message.decode(
                            e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer
                        );
                        msg = msg.deviceSentMessage?.message || msg;
                        if (msg.senderKeyDistributionMessage) {
                            try {
                                await repository.processSenderKeyDistributionMessage({
                                    authorJid: author,
                                    item: msg.senderKeyDistributionMessage
                                });
                            } catch (err) {
                                logger.error({ key: fullMessage.key, err }, 'failed to decrypt message');
                            }
                        }

                        if (fullMessage.message) {
                            Object.assign(fullMessage.message, msg);
                        } else {
                            fullMessage.message = msg;
                        }
                    } catch (err) {
                        logger.error({ key: fullMessage.key, err }, 'failed to decrypt message');
                        fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                        fullMessage.messageStubParameters = [err.message];
                    }
                }
            }

            if (!decryptables) {
                fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT];
            }
        }
    };
}

module.exports = {
    decodeMessageNode,
    decryptMessageNode,
    NO_MESSAGE_FOUND_ERROR_TEXT,
    MISSING_KEYS_ERROR_TEXT,
    NACK_REASONS
};