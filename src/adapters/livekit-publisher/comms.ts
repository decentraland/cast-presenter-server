/** Presentation data-channel codec and presenter parsing shared by the rtc-node and sidecar publishers. */
import { Packet } from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'

const PROTOCOL_VERSION = 100
const MSG_TYPE_COMMS_DATA = 3
const PRESENTATION_TOPIC = 'presentation'

function encodeCommsPayload(topic: string, jsonData: string): Uint8Array {
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

function decodeCommsPayload(sceneData: Uint8Array): { topic: string; data: string } | null {
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
  try {
    const packet = Packet.decode(payload)
    if (packet.message?.$case !== 'scene') return null
    const { sceneId, data } = packet.message.scene
    const decoded = decodeCommsPayload(data)
    if (!decoded || decoded.topic !== PRESENTATION_TOPIC) return null
    const message: Record<string, unknown> = JSON.parse(decoded.data)
    return message ? { message, sceneId: sceneId || undefined } : null
  } catch {
    try {
      const message: Record<string, unknown> = JSON.parse(new TextDecoder().decode(payload))
      return message ? { message } : null
    } catch {
      return null
    }
  }
}
