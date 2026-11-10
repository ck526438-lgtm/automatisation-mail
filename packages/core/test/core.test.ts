import { describe, expect, it } from "vitest";
import {
  advance, allowedCampaignVolume, appendReplyStopFooter, applyMapping, isLoopback, checkDomain, checkEmail, classifyBounce, contentSpamCheck,
  decryptSecret, dedupeContacts, encryptSecret, extractVariables, healthScore, instrumentHtml, isInWindow,
  matchesSegment, nextWindowStart, normalizeEmail, parseCsv, render, segmentToSql, shouldPauseCampaign,
  signToken, startNodeId, suggestMapping, threeStepColdSequence, unsubscribeHeaders, validateWorkflow,
  verifyToken, warmupPlan, WorkflowValidationError, type DnsResolver, type WorkflowGraph,
} from "../src/index.js";

describe("e-mails", () => {
  it("normalise et replie les alias Gmail", () => {
    expect(normalizeEmail("  Jean.Dupont+promo@GMAIL.com ", { collapseGmailAliases: true })).toBe("jeandupont@gmail.com");
    expect(normalizeEmail("Awa@Societe.CI")).toBe("awa@societe.ci");
  });
  it("détecte syntaxe, jetables et adresses de rôle", () => {
    expect(checkEmail("pas-un-email").valid).toBe(false);
    expect(checkEmail("x@yopmail.com")).toMatchObject({ valid: false, reason: "disposable" });
    expect(checkEmail("contact@entreprise.ci")).toMatchObject({ valid: true, isRole: true });
  });
  it("dédoublonne en complétant les champs vides et respecte la suppression", () => {
    const r = dedupeContacts(
      [
        { email: "a@x.com", company: "" },
        { email: "A@X.com", company: "Acme" },
        { email: "bad" },
        { email: "stop@x.com" },
      ],
      { suppressed: new Set(["stop@x.com"]) },
    );
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0]!.company).toBe("Acme");
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toHaveLength(1);
    expect(r.suppressed).toBe(1);
  });
});

describe("rebonds", () => {
  it.each([
    [{ code: 550, enhanced: "5.1.1", message: "User unknown" }, "hard"],
    [{ message: "452 4.2.2 Mailbox full, try again later" }, "soft"],
    [{ code: 552, enhanced: "5.2.2" }, "soft"],
    [{ message: "550 5.7.1 rejected: listed on Spamhaus" }, "block"],
    [{ message: "421 Too many connections" }, "soft"],
    [{ message: "550 Cette adresse n'existe pas" }, "hard"],
  ] as const)("%j → %s", (input, kind) => {
    expect(classifyBounce(input).kind).toBe(kind);
  });
});

describe("DNS", () => {
  const zone: Record<string, string[]> = {
    "acme.ci": ["v=spf1 include:_spf.google.com ~all", "google-site-verification=xyz"],
    "_spf.google.com": ["v=spf1 include:_netblocks.google.com ~all"],
    "_netblocks.google.com": ["v=spf1 ip4:35.190.247.0/24 ~all"],
    "_dmarc.acme.ci": ["v=DMARC1; p=none; rua=mailto:dmarc@acme.ci"],
    "google._domainkey.acme.ci": [`v=DKIM1; k=rsa; p=${"A".repeat(392)}`],
  };
  const resolver: DnsResolver = {
    resolveTxt: async (n) => {
      if (!zone[n]) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      return zone[n]!.map((r) => [r]);
    },
    resolveMx: async (n) => (n === "acme.ci" ? [{ exchange: "aspmx.l.google.com", priority: 1 }] : []),
  };

  it("valide SPF, DKIM, DMARC et MX", async () => {
    const report = await checkDomain("acme.ci", { resolver });
    expect(report.spf.status).toBe("ok");
    expect(report.dkim.status).toBe("ok");
    expect(report.dmarc.status).toBe("warning"); // p=none
    expect(report.mx.status).toBe("ok");
    expect(report.sendable).toBe(true);
  });
  it("signale un domaine sans authentification", async () => {
    const report = await checkDomain("vide.ci", { resolver });
    expect(report.spf.status).toBe("missing");
    expect(report.sendable).toBe(false);
  });
});

describe("templates", () => {
  it("remplace les variables, gère les replis et l'échappement", () => {
    const r = render("Bonjour {{prenom|là}}, {{societe}}", { societe: "<A&B>" }, { html: true });
    expect(r.output).toBe("Bonjour là, &lt;A&amp;B&gt;");
    expect(r.missing).toEqual([]);
    expect(render("{{poste}}", {}).missing).toEqual(["poste"]);
  });
  it("résout le spintax de façon déterministe sans toucher aux valeurs", () => {
    const t = "{Bonjour|Salut|Hello} {{prenom}}";
    const a = render(t, { prenom: "A|B" }, { seed: 42 }).output;
    expect(a).toBe(render(t, { prenom: "A|B" }, { seed: 42 }).output);
    expect(a).toMatch(/^(Bonjour|Salut|Hello) A\|B$/);
  });
  it("liste les variables", () => {
    expect(extractVariables("{{prenom}} {{societe|vous}} {{prenom}}")).toEqual(["prenom", "societe"]);
  });
});

describe("workflow", () => {
  const graph = threeStepColdSequence(["t1", "t2", "t3"]);
  const contact = { tags: [], fields: {} };
  const t0 = new Date("2026-11-02T09:00:00Z");

  it("valide la séquence modèle et refuse les cycles", () => {
    expect(() => validateWorkflow(graph)).not.toThrow();
    const cyclic: WorkflowGraph = {
      nodes: [
        { id: "s", type: "start", next: "a" },
        { id: "a", type: "wait", delay: { amount: 1, unit: "days" }, next: "b" },
        { id: "b", type: "wait", delay: { amount: 1, unit: "days" }, next: "a" },
      ],
    };
    expect(() => validateWorkflow(cyclic)).toThrow(WorkflowValidationError);
  });

  it("envoie le premier e-mail puis attend 3 jours", () => {
    const r1 = advance(graph, { currentNodeId: startNodeId(graph), state: "active", enteredNodeAt: t0.toISOString() }, contact, [], t0);
    expect(r1.effects).toEqual([{ kind: "send_email", nodeId: "email1", templateId: "t1", threadWith: undefined }]);
    const r2 = advance(graph, r1, contact, [], t0);
    expect(r2.state).toBe("waiting");
    expect(r2.nextRunAt).toBe("2026-11-05T09:00:00.000Z");
  });

  it("branche sur le clic et ajoute le tag", () => {
    const later = new Date("2026-11-05T09:00:00Z");
    const r = advance(graph, { currentNodeId: "wait1", state: "waiting", enteredNodeAt: t0.toISOString() }, contact,
      [{ type: "click", nodeId: "email1", occurredAt: "2026-11-03T10:00:00Z" }], later);
    expect(r.effects).toContainEqual({ kind: "add_tag", tag: "chaud" });
    expect(r.effects).toContainEqual({ kind: "send_email", nodeId: "email2", templateId: "t2", threadWith: "email1" });
  });

  it("s'arrête dès qu'une réponse arrive", () => {
    const r = advance(graph, { currentNodeId: "wait1", state: "waiting", enteredNodeAt: t0.toISOString() }, contact,
      [{ type: "reply", occurredAt: "2026-11-03T10:00:00Z" }], new Date("2026-11-10T00:00:00Z"));
    expect(r).toMatchObject({ state: "stopped", stopReason: "reply", effects: [] });
  });

  it("une réponse automatique ou un soft bounce ne stoppe pas", () => {
    const r = advance(graph, { currentNodeId: "wait1", state: "waiting", enteredNodeAt: t0.toISOString() }, contact,
      [{ type: "auto_reply", occurredAt: t0.toISOString() }, { type: "bounce", bounceKind: "soft", occurredAt: t0.toISOString() }], t0);
    expect(r.state).toBe("waiting");
  });

  it("attente d'événement : branche « non » après le délai", () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: "s", type: "start", next: "w" },
        { id: "w", type: "wait_for_event", event: "open", timeout: { amount: 2, unit: "days" }, yes: "ok", no: "ko" },
        { id: "ok", type: "end", outcome: "interested" },
        { id: "ko", type: "end", outcome: "completed" },
      ],
    };
    const enr = { currentNodeId: "w", state: "waiting" as const, enteredNodeAt: t0.toISOString() };
    expect(advance(g, enr, contact, [], new Date("2026-11-03T09:00:00Z")).state).toBe("waiting");
    expect(advance(g, enr, contact, [], new Date("2026-11-04T09:00:01Z"))).toMatchObject({ state: "completed", stopReason: "completed" });
    expect(advance(g, enr, contact, [{ type: "open", occurredAt: "2026-11-03T08:00:00Z" }], new Date("2026-11-03T09:00:00Z")))
      .toMatchObject({ state: "completed", stopReason: "interested" });
  });
});

describe("segments", () => {
  const rule = {
    all: [
      { field: "title", op: "contains" as const, value: "directeur" },
      { activity: "click" as const, withinDays: 30, has: true },
      { not: { tag: "client", has: true } },
    ],
  };
  const now = new Date("2026-11-10T00:00:00Z");
  it("évalue un arbre ET/OU/NON", () => {
    expect(matchesSegment(rule, { fields: { title: "Directeur commercial" }, tags: [], lastActivity: { click: "2026-11-01T00:00:00Z" } }, now)).toBe(true);
    expect(matchesSegment(rule, { fields: { title: "Directeur" }, tags: ["client"], lastActivity: { click: "2026-11-01T00:00:00Z" } }, now)).toBe(false);
    expect(matchesSegment(rule, { fields: { title: "Directeur" }, tags: [], lastActivity: { click: "2026-08-01T00:00:00Z" } }, now)).toBe(false);
  });
  it("compile en SQL paramétré", () => {
    const params: unknown[] = [];
    const sql = segmentToSql({ any: [{ field: "company", op: "eq", value: "Acme" }, { field: "secteur", op: "exists" }] }, params);
    expect(sql).toBe("(lower(coalesce(c.company, '')) = $1 OR coalesce((c.custom_fields ->> $2::text), '') <> '')");
    expect(params).toEqual(["acme", "secteur"]);
    expect(() => segmentToSql({ field: "x; DROP TABLE", op: "exists" }, [])).toThrow();
  });
});

describe("fenêtres d'envoi", () => {
  const w = { timezone: "Africa/Abidjan", startHour: 8, endHour: 17, days: [1, 2, 3, 4, 5] };
  it("repousse au lundi 8 h un envoi du samedi", () => {
    const sat = new Date("2026-11-07T12:00:00Z");
    expect(isInWindow(sat, w)).toBe(false);
    expect(nextWindowStart(sat, w).toISOString()).toBe("2026-11-09T08:00:00.000Z");
  });
  it("respecte le fuseau du destinataire", () => {
    const paris = { ...w, timezone: "Europe/Paris" };
    // 7 h 30 UTC un mardi = 8 h 30 à Paris (heure d'hiver)
    expect(isInWindow(new Date("2026-11-10T07:30:00Z"), paris)).toBe(true);
    expect(isInWindow(new Date("2026-11-10T07:30:00Z"), w)).toBe(false);
  });
});

describe("délivrabilité", () => {
  it("suit le plan de warm-up", () => {
    expect(warmupPlan(0)).toEqual({ warmup: 5, campaign: 0 });
    expect(warmupPlan(6).campaign).toBe(0);
    expect(warmupPlan(13).campaign).toBe(10);
    expect(warmupPlan(30, 80)).toEqual({ warmup: 40, campaign: 80 });
  });
  it("calcule le score et freine les boîtes en mauvaise santé", () => {
    const good = healthScore({ inboxRate: 0.98, bounceRate: 0.01, complaintRate: 0, blacklistHits: 0, dnsOk: true });
    const bad = healthScore({ inboxRate: 0.5, bounceRate: 0.06, complaintRate: 0.004, blacklistHits: 1, dnsOk: true });
    expect(good).toBeGreaterThanOrEqual(90);
    expect(bad).toBeLessThan(50);
    expect(allowedCampaignVolume(30, 100, 60)).toBe(50);
    expect(allowedCampaignVolume(30, 100, bad)).toBe(0);
  });
  it("met en pause au-delà des seuils", () => {
    expect(shouldPauseCampaign({ sent: 200, bounced: 12, complaints: 0 }).pause).toBe(true);
    expect(shouldPauseCampaign({ sent: 1000, bounced: 10, complaints: 4 }).pause).toBe(true);
    expect(shouldPauseCampaign({ sent: 20, bounced: 10, complaints: 0 }).pause).toBe(false);
  });
  it("repère le contenu à risque", () => {
    expect(contentSpamCheck("OFFRE GRATUITE !!!", "Cliquez ici").score).toBeGreaterThan(5);
    expect(contentSpamCheck("Question rapide", "Bonjour Awa, avez-vous 10 minutes jeudi ?").score).toBe(0);
  });
});

describe("tracking et conformité", () => {
  const secret = "test-secret";
  it("signe et vérifie les jetons", () => {
    const token = signToken({ m: "msg1", t: "c", u: "https://exemple.ci" }, secret);
    expect(verifyToken(token, secret)).toEqual({ m: "msg1", t: "c", u: "https://exemple.ci" });
    expect(verifyToken(token, "autre")).toBeNull();
    expect(verifyToken(token.slice(0, -2) + "xx", secret)).toBeNull();
  });
  it("réécrit les liens et ajoute le pixel", () => {
    const html = instrumentHtml('<p><a href="https://site.ci/offre">voir</a></p>', {
      baseUrl: "https://t.acme.ci", secret, messageId: "m1", trackOpens: true, trackClicks: true,
    });
    expect(html).toMatch(/href="https:\/\/t\.acme\.ci\/c\/[\w-]+\.[\w-]+"/);
    expect(html).toMatch(/<img src="https:\/\/t\.acme\.ci\/o\/.+\.gif"/);
  });
  it("produit les en-têtes de désinscription en un clic", () => {
    expect(unsubscribeHeaders("https://t.acme.ci/u/abc")).toEqual({
      "List-Unsubscribe": "<https://t.acme.ci/u/abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
  it("repère une adresse inaccessible aux destinataires et propose la désinscription par réponse", () => {
    expect(isLoopback("http://127.0.0.1:47811")).toBe(true);
    expect(isLoopback("http://localhost:4000")).toBe(true);
    expect(isLoopback("https://t.acme.ci")).toBe(false);
    const b = appendReplyStopFooter({ html: "<p>Bonjour</p>", text: "Bonjour" }, { senderName: "Awa", postalAddress: "Cocody, Abidjan" });
    expect(b.text).toContain("répondez simplement « STOP »");
    expect(b.text).toContain("Awa · Cocody, Abidjan");
  });

  it("chiffre et déchiffre les secrets", () => {
    const key = "11".repeat(32);
    const enc = encryptSecret("mot-de-passe-smtp", key);
    expect(enc).not.toContain("mot-de-passe");
    expect(decryptSecret(enc, key)).toBe("mot-de-passe-smtp");
    expect(() => decryptSecret(enc, "22".repeat(32))).toThrow();
    expect(decryptSecret(encryptSecret("", key), key)).toBe("");
  });
});

describe("import CSV", () => {
  it("détecte le point-virgule, les guillemets et mappe les colonnes", () => {
    const rows = parseCsv('﻿E-mail;Prénom;Société;Secteur\n"awa@acme.ci";Awa;"Acme; SARL";BTP\n\n');
    expect(rows).toEqual([["E-mail", "Prénom", "Société", "Secteur"], ["awa@acme.ci", "Awa", "Acme; SARL", "BTP"]]);
    const mapping = suggestMapping(rows[0]!);
    expect(mapping).toEqual({ 0: "email", 1: "first_name", 2: "company", 3: "custom:secteur" });
    expect(applyMapping(rows.slice(1), mapping)[0]).toEqual({ email: "awa@acme.ci", first_name: "Awa", company: "Acme; SARL", custom_fields: { secteur: "BTP" } });
  });
});
