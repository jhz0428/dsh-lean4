// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * LSP base protocol framing (the `Content-Length` header dance).
 *
 * Kept in its own file because it is the one piece of the host half that is
 * easy to get subtly wrong and easy to test without a language server: the
 * reader must survive split chunks, coalesced messages, and a header block
 * that arrives across two TCP reads.
 */

/** The header/body separator every LSP message uses. */
export const HEADER_SEPARATOR = '\r\n\r\n';

/**
 * Encode one JSON-RPC message into a `Content-Length` framed buffer.
 *
 * Length is the **byte** length of the UTF-8 body, not the character length:
 * Lean diagnostics and goals are full of `∀`, `→`, `α`, and a character-based
 * length would cut the body mid-codepoint on the server side.
 */
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = `Content-Length: ${body.length}${HEADER_SEPARATOR}`;
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

/**
 * Create a stateful frame reader. Feed it raw stdout chunks; it calls
 * `handler(message)` once per complete JSON message.
 *
 * A frame whose header lacks `Content-Length` is dropped rather than thrown:
 * a malformed frame from a crashed server must not take the caller down, and
 * there is no way to resynchronise better than scanning for the next header
 * terminator, which is what dropping the header block does.
 */
export function createMessageReader(handler, onWarning = () => {}) {
  let buffer = Buffer.alloc(0);

  function drain() {
    for (;;) {
      const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (match === null) {
        onWarning(`dropped a frame header without Content-Length: ${header.slice(0, 120)}`);
        buffer = buffer.subarray(bodyStart);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isFinite(length) || length < 0) {
        onWarning(`dropped a frame with an unusable Content-Length: ${header.slice(0, 120)}`);
        buffer = buffer.subarray(bodyStart);
        continue;
      }
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        onWarning(`dropped a frame whose body was not JSON: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      handler(parsed);
    }
  }

  return {
    /** Feed one stdout chunk (any size, including a partial header). */
    push(chunk) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      drain();
    },
    /** Bytes still waiting for their body — used by tests and diagnostics. */
    get pending() {
      return buffer.length;
    },
  };
}
