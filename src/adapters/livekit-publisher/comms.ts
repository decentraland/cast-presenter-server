/** Presentation data-channel codec and presenter parsing shared by the rtc-node and sidecar publishers. */
import { Packet } from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'

/** `Packet.protocolVersion` stamped on every outgoing packet. */
export const PROTOCOL_VERSION = 100
/** CommsData message type byte that leads `Scene.data`. */
export const MSG_TYPE_COMMS_DATA = 3
/** CommsData topic of presentation messages. */
export const PRESENTATION_TOPIC = 'presentation'

/** Encodes topic + JSON data as CommsData: [MsgType][topicLen 2 bytes LE][topic UTF-8][data UTF-8]. */
export function encodeCommsPayload(topic: string, jsonData: string): Uint8Array {
  const topicBytes = new TextEncoder().encode(topic)
  const dataBytes = new TextEncoder().encode(jsonData)
  const payload = new Uint8Array(1 + 2 + topicBytes.length + dataBytes.length)
  payload[0] = MSG_TYPE_COMMS_DATA
  payload[1] = topicBytes.length & 0xff
  payload[2] = (topicBytes.length >> 8) & 0xff
  payload.set(topicBytes, 3)
  payload.set(dataBytes, 3 + topicBytes.length)
  return payload
}

/**
 * Decodes CommsData wire format from Scene.data.
 * @param sceneData - the full payload, including the leading MsgType byte.
 * @returns `{ topic, data }`, or null if malformed.
 */
export function decodeCommsPayload(sceneData: Uint8Array): { topic: string; data: string } | null {
  if (sceneData.length < 1 || sceneData[0] !== MSG_TYPE_COMMS_DATA) return null
  const inner = sceneData.subarray(1)
  if (inner.length < 2) return null
  const topicLen = inner[0] | (inner[1] << 8)
  if (inner.length < 2 + topicLen) return null
  const topic = new TextDecoder().decode(inner.subarray(2, 2 + topicLen))
  const data = new TextDecoder().decode(inner.subarray(2 + topicLen))
  return { topic, data }
}

/**
 * Reads the `presenters` array from LiveKit room metadata.
 * @returns the non-empty string identities, lowercased; an empty set for missing or malformed metadata.
 */
export function parsePresentersFromRoomMetadata(metadata: string | undefined): Set<string> {
  try {
    if (!metadata) return new Set()
    const parsed = JSON.parse(metadata)
    if (!Array.isArray(parsed?.presenters)) return new Set()
    return new Set(
      parsed.presenters
        .filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)
        .map((p: string) => p.toLowerCase())
    )
  } catch {
    return new Set()
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Wraps a presentation message in a protobuf `Packet` scene message on the presentation topic.
 * @returns the encoded packet bytes.
 */
export function encodePresentationPacket(message: Record<string, unknown>, sceneId: string): Uint8Array {
  const sceneData = encodeCommsPayload(PRESENTATION_TOPIC, JSON.stringify(message))
  return Packet.encode({
    message: { $case: 'scene', scene: { sceneId, data: sceneData } },
    protocolVersion: PROTOCOL_VERSION
  }).finish()
}

/**
 * Decodes an incoming data packet: a protobuf `Packet` scene message on the presentation topic,
 * or raw JSON when the bytes are not a `Packet`.
 * @returns the message and the packet's scene id, or null when no message could be read.
 */
export function decodePresentationPacket(
  payload: Uint8Array
): { message: Record<string, unknown>; sceneId?: string } | null {
  let message: Record<string, unknown> | undefined
  let sceneId: string | undefined
  try {
    const packet = Packet.decode(payload)
    if (packet.message?.$case === 'scene') {
      if (packet.message.scene.sceneId) {
        sceneId = packet.message.scene.sceneId
      }
      const decoded = decodeCommsPayload(packet.message.scene.data)
      if (decoded && decoded.topic === PRESENTATION_TOPIC) {
        message = JSON.parse(decoded.data)
      }
    }
  } catch {
    message = parseJson(new TextDecoder().decode(payload))
  }
  if (!message) return null
  return { message, sceneId }
}
