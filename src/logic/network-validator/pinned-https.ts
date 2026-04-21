import * as https from 'https'
import type { IncomingMessage } from 'http'

/**
 * Makes a single HTTPS request with DNS pinned to pre-validated addresses.
 *
 * Uses a custom https.Agent lookup to prevent DNS rebinding: the TCP
 * connection is forced to one of the addresses we already validated,
 * while TLS still verifies the certificate against the original hostname.
 */
export function pinnedHttpsRequest(
  url: string,
  hostname: string,
  addresses: string[]
): Promise<{ response: IncomingMessage; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({
      lookup: (_host, opts, cb) => {
        // Node.js 24+ passes { all: true }, which changes the callback signature:
        //   all=false: cb(null, address, family)
        //   all=true:  cb(null, [{address, family}, ...])
        if (opts && (opts as Record<string, unknown>).all) {
          cb(null, addresses.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 })) as unknown as string, 0)
        } else {
          const addr = addresses[0]
          cb(null, addr, addr.includes(':') ? 6 : 4)
        }
      },
      maxSockets: 1
    })

    const req = https.request(url, { agent }, (res) => {
      resolve({
        response: res,
        destroy: () => {
          req.destroy()
          agent.destroy()
        }
      })
    })

    req.on('error', (err) => {
      agent.destroy()
      reject(err)
    })
    req.end()
  })
}
