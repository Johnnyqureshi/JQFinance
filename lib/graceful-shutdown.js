'use strict';

function closeServer(server, { timeoutMs = 15_000 } = {}) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let complete = false;
    const finish = (error) => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      server.closeAllConnections?.();
      finish(new Error(`HTTP server did not drain within ${timeoutMs}ms; fence release withheld.`));
    }, timeoutMs);
    server.close(finish);
    server.closeIdleConnections?.();
  });
}

module.exports = { closeServer };