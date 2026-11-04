// Control: the pre-fix shape. A stdin Writable with no 'error' listener whose
// child dies -> EPIPE becomes an uncaughtException and kills the process.
// Reproduces "dsh: fatal uncaught exception: Error: write EPIPE" -> host exit 1.
import { Writable } from 'node:stream';

const stdin = new Writable({
  write(_chunk, _encoding, callback) {
    const error = new Error('EPIPE: broken pipe, write');
    error.code = 'EPIPE';
    callback(error);
  },
});
process.on('uncaughtException', (error) => {
  process.stderr.write(`UNCAUGHT ${error.code} -> host would exit(1)\n`);
  process.exit(1);
});
stdin.write('{"jsonrpc":"2.0","method":"textDocument/didChange"}');
setTimeout(() => process.stderr.write('survived (unexpected)\n'), 300);
