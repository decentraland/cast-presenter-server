import { parsePresentersFromRoomMetadata } from '../../src/adapters/livekit-publisher/comms'

describe('when parsing presenters from room metadata with non-string entries', () => {
  let presenters: Set<string>

  beforeEach(() => {
    presenters = parsePresentersFromRoomMetadata(JSON.stringify({ presenters: ['0xABC', 42, null, { id: 'x' }, ''] }))
  })

  it('should keep only the non-empty strings, lowercased', () => {
    expect([...presenters]).toEqual(['0xabc'])
  })
})
