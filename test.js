"use strict";
const https = require("https");
const fs = require("fs");
const brotli = require("brotli");
const puppeteer = require("puppeteer");
const forge = require("node-forge");

(async () => {
  const server = await startServer(createCert());
  try {
    await usingBrowser(
      { headless: false, args: ["--allow-insecure-localhost"] },
      async browser => {
        await runTest(browser);
      }
    );

    await usingBrowser(
      { headless: true, args: ["--allow-insecure-localhost"] },
      async browser => {
        await runTest(browser);
      }
    );
  } finally {
    await server.close();
  }
})();

/**
 * @param {import('puppeteer').Browser} browser
 */
async function runTest(browser) {
  const page = await browser.newPage();

  page.on("request", e => {
    console.log(`[puppeteer]: request ${e.url()}`);
  });
  page.on("requestfailed", e => {
    console.log(
      `[puppeteer]: requestfailed ${e.url()} ${e.failure().errorText}`
    );
  });
  page.on("requestfinished", e => {
    console.log(`[puppeteer]: requestfinished ${e.url()}`);
  });

  await page.goto("https://localhost:3333/", {
    waitUntil: "load"
  });
  const html = await page.evaluate(() => {
    return document.body.innerHTML;
  });
  if (html === "<h1>It works</h1>") {
    console.log(`[puppeteer]: PASSED`);
  } else {
    console.log(
      `[puppeteer]: FAILED rendered "${html}" but expected "<h1>It works</h1>"`
    );
  }
}

/**
 * @param {{ key: Buffer, cert: Buffer }} opts
 */
async function startServer(opts) {
  const server = https.createServer(opts, (req, res) => {
    if (req.url === "/index.html" || req.url === "/") {
      const index = fs.readFileSync(__dirname + "/index.html");
      res.writeHead(200, {
        "content-length": index.byteLength,
        "content-type": "text/html"
      });
      res.end(index);
      console.log(`[server]: 200 ${req.url}`);
    } else if (req.url === "/index.js") {
      const body = brotli.compress(
        fs.readFileSync(__dirname + "/index.js"),
        {}
      );
      res.writeHead(200, {
        "content-length": body.byteLength,
        "content-encoding": "br",
        "content-type": "text/javascript;charset=utf8"
      });
      res.end(Buffer.from(body));
      console.log(
        `[server]: 200 ${req.url} accept-encoding: ${
          req.headers["accept-encoding"]
        }`
      );
    } else {
      res.writeHead(404);
      res.end();
      console.log(`[server]: 404 ${req.url}`);
    }
  });

  const closed = new Promise((resolve, reject) => {
    server.once("close", resolve);
    server.once("error", reject);
  });

  await Promise.race([
    closed.then(() => {
      throw new Error("closed early");
    }),
    new Promise(resolve => {
      server.listen(3333);
      server.once("listening", resolve);
    })
  ]);

  console.log(`[server]: listening on port 3333`);

  return {
    closed: closed,
    async close() {
      server.close();
      await closed;
    }
  };
}

/**
 * @param {import("puppeteer").LaunchOptions} opts
 * @param {(browser: import("puppeteer").Browser) => Promise<void>} callback
 */
async function usingBrowser(opts, callback) {
  console.log(`[puppeteer]: Launch ${JSON.stringify(opts)}`);
  const browser = await puppeteer.launch(opts);
  try {
    // Race callback against disconnect
    await Promise.race([
      callback(browser),
      (async () => {
        await new Promise(resolve => browser.on("disconnected", resolve));
        throw new Error("disconnected early");
      })()
    ]);
  } finally {
    browser.close();
  }
}

// Generate self signed cert
function createCert() {
  const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = "e5067be47fe1ca7e";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    {
      shortName: "CN",
      value: "localhost"
    }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(privateKey, forge.md.sha256.create());
  return {
    key: Buffer.from(forge.pki.privateKeyToPem(privateKey)),
    cert: Buffer.from(forge.pki.certificateToPem(cert))
  };
}
