import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { classifyInbound } from "@am/core";
import { composeMime } from "./send.js";
import { toInbound } from "./sync.js";

describe("composition MIME", () => {
  it("conserve Message-ID, fil et désinscription en un clic", async () => {
    const raw = (await composeMime({
      from: { name: "Awa", address: "awa@acme.ci" },
      to: "client@exemple.ci",
      subject: "Re: suivi",
      text: "Bonjour",
      html: "<p>Bonjour</p>",
      messageId: "<m2@acme.ci>",
      inReplyTo: "<m1@acme.ci>",
      references: ["<m1@acme.ci>"],
      headers: { "List-Unsubscribe": "<https://t.acme.ci/u/abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    })).toString();
    const unfolded = raw.replace(/\r\n[ \t]+/g, " ");
    expect(unfolded).toMatch(/^Message-ID: <m2@acme\.ci>$/m);
    expect(unfolded).toMatch(/^In-Reply-To: <m1@acme\.ci>$/m);
    expect(unfolded).toMatch(/^List-Unsubscribe: <https:\/\/t\.acme\.ci\/u\/abc>$/m);
    expect(unfolded).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  });
});

describe("lecture des messages reçus", () => {
  it("retrouve le message d'origine dans les parties d'un DSN", async () => {
    const raw = [
      "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      "Subject: Delivery Status Notification (Failure)",
      "MIME-Version: 1.0",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
      "",
      "--b", "Content-Type: text/plain", "", "Adresse introuvable.",
      "--b", "Content-Type: message/delivery-status", "",
      "Final-Recipient: rfc822; perdu@exemple.ci", "Action: failed", "Status: 5.1.1",
      "Diagnostic-Code: smtp; 550 5.1.1 user unknown",
      "--b", "Content-Type: text/rfc822-headers", "", "Message-ID: <orig@acme.ci>", "Subject: Bonjour",
      "--b--", "",
    ].join("\r\n");
    const verdict = classifyInbound(toInbound(await simpleParser(Buffer.from(raw))));
    expect(verdict).toMatchObject({ kind: "bounce", originalMessageId: "orig@acme.ci", recipient: "perdu@exemple.ci", bounce: { code: 550, enhanced: "5.1.1" } });
  });

  it("reconnaît une réponse par ses en-têtes", async () => {
    const raw = "From: Client <c@exemple.ci>\r\nSubject: Re: Bonjour\r\nIn-Reply-To: <orig@acme.ci>\r\n\r\nOui, volontiers.\r\n";
    expect(classifyInbound(toInbound(await simpleParser(Buffer.from(raw))))).toEqual({ kind: "reply", refs: ["orig@acme.ci"], autoReply: false });
  });
});
