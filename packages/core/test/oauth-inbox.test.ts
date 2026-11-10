import { describe, expect, it } from "vitest";
import {
  buildAuthUrl, classifyBounce, classifyInbound, exchangeCode, extractRefs, fetchMailboxIdentity, OAuthError,
  parseDsn, refreshAccessToken, signState, verifyState, type InboundMessage,
} from "../src/index.js";

const client = { clientId: "cid", clientSecret: "secret", redirectUri: "https://api.exemple.ci/oauth/gmail/callback" };

/** Faux fetch : enregistre les requêtes et renvoie la réponse prévue. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

describe("OAuth", () => {
  it("signe et vérifie le state, refuse falsification et expiration", () => {
    const s = signState({ orgId: "org1", provider: "gmail" }, "k", 1000, 0);
    expect(verifyState(s, "k", 500)).toMatchObject({ orgId: "org1", provider: "gmail" });
    expect(verifyState(s, "k", 2000)).toBeNull();
    expect(verifyState(s, "autre", 500)).toBeNull();
    expect(verifyState(s.replace(/.$/, "x"), "k", 500)).toBeNull();
  });

  it("construit l'URL Google avec accès hors ligne", () => {
    const u = new URL(buildAuthUrl("gmail", client, "st", "awa@acme.ci"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("scope")).toContain("gmail.send");
    expect(u.searchParams.get("login_hint")).toBe("awa@acme.ci");
  });

  it("construit l'URL Microsoft avec offline_access", () => {
    const u = new URL(buildAuthUrl("outlook", client, "st"));
    expect(u.hostname).toBe("login.microsoftonline.com");
    expect(u.searchParams.get("scope")).toContain("offline_access");
    expect(u.searchParams.get("scope")).toContain("Mail.Send");
  });

  it("échange le code et calcule l'expiration avec marge", async () => {
    const { f, calls } = fakeFetch(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 });
    const t = await exchangeCode("gmail", client, "code123", f, 0);
    expect(t).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    expect(t.expiresAt.getTime()).toBe(3540_000);
    const body = new URLSearchParams(String(calls[0]!.init!.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code123");
    expect(body.get("redirect_uri")).toBe(client.redirectUri);
  });

  it("signale un refresh_token révoqué", async () => {
    const { f } = fakeFetch(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    const err = await refreshAccessToken("outlook", client, "rt", f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).needsReconnect).toBe(true);
  });

  it("lit l'adresse de la boîte chez chaque fournisseur", async () => {
    expect(await fetchMailboxIdentity("gmail", "at", fakeFetch(200, { emailAddress: "Awa@Acme.ci" }).f)).toEqual({ email: "awa@acme.ci", name: undefined });
    expect(await fetchMailboxIdentity("outlook", "at", fakeFetch(200, { userPrincipalName: "yao@acme.ci", displayName: "Yao" }).f)).toEqual({ email: "yao@acme.ci", name: "Yao" });
  });
});

const msg = (p: Partial<InboundMessage>): InboundMessage => ({ headers: {}, from: "client@exemple.ci", subject: "", text: "", ...p });

describe("messages entrants", () => {
  it("extrait les références, In-Reply-To en premier", () => {
    expect(extractRefs(msg({ headers: { "In-Reply-To": "<b@x>", References: "<a@x> <b@x>" } }))).toEqual(["b@x", "a@x"]);
  });

  it("classe une réponse humaine et une absence", () => {
    expect(classifyInbound(msg({ headers: { "in-reply-to": "<m1@acme.ci>" }, subject: "Re: Question rapide" })))
      .toEqual({ kind: "reply", refs: ["m1@acme.ci"], autoReply: false });
    expect(classifyInbound(msg({ headers: { "In-Reply-To": "<m1@acme.ci>", "Auto-Submitted": "auto-replied" }, subject: "Absent du bureau" })))
      .toMatchObject({ kind: "reply", autoReply: true });
  });

  it("ignore les messages sans lien et ceux de la boîte elle-même", () => {
    expect(classifyInbound(msg({ subject: "Newsletter" })).kind).toBe("ignore");
    expect(classifyInbound(msg({ from: "Moi <moi@acme.ci>", headers: { "in-reply-to": "<x@y>" } }), "moi@acme.ci").kind).toBe("ignore");
  });

  it("analyse un DSN RFC 3464 (Gmail)", () => {
    const dsn = msg({
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      subject: "Delivery Status Notification (Failure)",
      headers: { "Content-Type": 'multipart/report; report-type=delivery-status; boundary="x"' },
      text: [
        "Address not found", "",
        "Reporting-MTA: dns; googlemail.com",
        "Final-Recipient: rfc822; inconnu@exemple.ci",
        "Action: failed",
        "Status: 5.1.1",
        "Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.",
        "", "Message-ID: <abc-123@acme.ci>", "Subject: Question rapide",
      ].join("\n"),
    });
    const v = classifyInbound(dsn);
    expect(v).toMatchObject({ kind: "bounce", originalMessageId: "abc-123@acme.ci", recipient: "inconnu@exemple.ci" });
    if (v.kind !== "bounce") throw new Error();
    expect(v.bounce).toMatchObject({ code: 550, enhanced: "5.1.1" });
    expect(classifyBounce(v.bounce).kind).toBe("hard");
  });

  it("analyse un rebond Exchange en français et une boîte pleine", () => {
    const fr = parseDsn(msg({
      from: "postmaster@outlook.com", subject: "Non remis : Question rapide",
      text: "Le message n'a pas pu être remis.\nRemote Server returned '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found'\nOriginal-Recipient: rfc822;nobody@exemple.fr",
      headers: { References: "<orig-9@acme.ci>" },
    }));
    expect(fr).toMatchObject({ originalMessageId: "orig-9@acme.ci", recipient: "nobody@exemple.fr", bounce: { code: 550, enhanced: "5.1.10" } });
    const full = parseDsn(msg({ subject: "Undeliverable", text: "Status: 4.2.2\nDiagnostic-Code: smtp; 452 4.2.2 Mailbox full\nMessage-ID: <q@acme.ci>" }));
    expect(classifyBounce(full.bounce).kind).toBe("soft");
  });
});
