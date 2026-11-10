<p align="center">
  <img src="docs/assets/logo.jpg" alt="Automatisation Mail" width="420">
</p>

<p align="center">
  <b>SaaS B2B d'automatisation d'e-mails</b> : séquences de prospection et de rétention,<br>
  workflows conditionnels, délivrabilité protégée par défaut, conformité RGPD / CAN-SPAM intégrée.
</p>

<p align="center">
  <img alt="CI" src="https://github.com/ck526438-lgtm/automatisation-mail/actions/workflows/ci.yml/badge.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.9-1f5fbf">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-1f5fbf">
  <img alt="Statut" src="https://img.shields.io/badge/statut-MVP-f2771f">
</p>

---

## Ce que fait le MVP aujourd'hui

| Module | Fonctionnalités |
| --- | --- |
| **Contacts** | Import CSV (séparateur `,` ou `;`, mapping automatique des colonnes en français/anglais), API unitaire et en lot (1 000/appel), dédoublonnage (`ignorer`, `écraser`, `compléter`), rejet des adresses invalides et jetables, tags, segments dynamiques ET/OU/NON compilés en SQL paramétré |
| **Séquences** | Moteur de workflow en graphe (DAG) : e-mail, attente, condition (ouvert, cliqué, répondu, tag, champ), attente d'événement avec délai, actions (tag, webhook, statut), fin. Versionnement : un contact reste sur la version où il a été inscrit |
| **Boîtes** | Connexion Google Workspace et Microsoft 365 en un clic (OAuth, jetons chiffrés et rafraîchis automatiquement, détection des révocations), ou SMTP + IMAP pour les autres hébergeurs. Voir [docs/oauth.md](docs/oauth.md) |
| **Envoi** | Workers BullMQ, envoi par API Gmail, Microsoft Graph ou SMTP avec un MIME identique, rotation des boîtes, relances dans le même fil (`In-Reply-To`), spintax et variables avec valeurs de repli, fenêtres horaires dans le fuseau du contact, espacement aléatoire entre envois, idempotence (aucun double envoi) |
| **Délivrabilité** | Vérification SPF (dont limite des 10 requêtes DNS), DKIM (taille de clé), DMARC (politique), MX. Plan de warm-up progressif, score de santé par boîte, freinage automatique (volume divisé par 2 sous 70, arrêt sous 50), pause de campagne au-delà de 5 % de rebonds ou 0,3 % de plaintes, analyse anti-spam du contenu |
| **Rebonds & réponses** | Lecture automatique des boîtes toutes les 2 minutes (Gmail, Microsoft Graph, IMAP) : réponses rattachées par `In-Reply-To` / `References`, rapports de non-remise (RFC 3464, Gmail, Exchange) analysés, déduplication entre passages. Classification hard / soft / bloc, webhooks génériques et Amazon SES en complément, réponses automatiques (RFC 3834) qui ne stoppent pas la séquence |
| **Tracking** | Pixel d'ouverture (désactivé par défaut en prospection), redirection des clics avec jetons signés HMAC, filtrage des ouvertures et clics de robots (proxys d'images, scanners de sécurité), statistiques par campagne et par étape |
| **Conformité** | Lien de désinscription et adresse postale injectés dans chaque e-mail, en-têtes `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058, exigés par Gmail et Yahoo), liste de suppression par organisation et globale, journal du consentement, export et effacement d'un contact (droits RGPD) |
| **Comptes & équipe** | Inscription (création d'organisation), connexion par e-mail et mot de passe (scrypt), sessions en cookie httpOnly, blocage après 5 essais, invitations à usage unique valables 7 jours, rôles propriétaire / administrateur / membre, journal d'activité, clé API régénérable pour les intégrations |
| **Interface** | Tableau de bord Next.js : indicateurs, campagnes (démarrer, mettre en pause, inscrire), contacts (import, recherche), boîtes (connexion, santé, warm-up, quotas), vérificateur DNS, équipe et réglages |

## Architecture

```
apps/
  api/       Fastify — API REST /v1, tracking public, désinscription, webhooks entrants
  worker/    BullMQ — scheduler des séquences, envoi SMTP, maintenance (santé, DNS)
  web/       Next.js 15 — interface d'administration
packages/
  core/      Logique métier pure et testée (workflow, rebonds, DNS, templates, segments, warm-up, tracking)
  db/        Schéma PostgreSQL (Drizzle ORM), services partagés, données de démonstration
```

L'API n'envoie jamais d'e-mail elle-même : elle écrit en base et crée des inscriptions. Le scheduler réclame les inscriptions dues (`FOR UPDATE SKIP LOCKED`, plusieurs workers possibles), fait avancer chaque contact dans son graphe et met les envois en file. Tout ce qui revient (réponses, rebonds, clics, désinscriptions) redevient un événement qui fait avancer ou arrête les séquences.

La spécification complète (architecture, modèle de données, roadmap) est décrite dans le document de cadrage du projet.

## Démarrage rapide

Prérequis : Node.js 22.9 ou plus, pnpm 9, Docker.

```bash
git clone https://github.com/ck526438-lgtm/automatisation-mail.git
cd automatisation-mail
cp .env.example .env
pnpm install

docker compose up -d          # PostgreSQL, Redis, Mailpit
pnpm db:push                  # crée les tables
pnpm db:seed                  # organisation de démo, boîte SMTP vers Mailpit, séquence en 3 étapes, 3 contacts
pnpm dev                      # API :4000, worker, interface :3000
```

Puis :

1. Ouvrez http://localhost:3000 et connectez-vous avec le compte de démo : `demo@automatisation-mail.local` / `Demo-Abidjan-2026`.
   Ou créez votre propre organisation depuis **Créer une organisation**.
2. Allez dans **Campagnes**, cliquez **Inscrire tous** puis **Démarrer**.
3. Les e-mails arrivent dans Mailpit : http://localhost:8025.

En développement, raccourcissez l'espacement entre envois dans `.env` : `MIN_GAP_SECONDS=0` et `MAX_GAP_SECONDS=2`.

## Exemples d'API

Pour un script ou un CRM, les routes `/v1` acceptent l'en-tête `x-api-key` (droits d'administrateur). La clé de démo est `dev-key-change-me` ; un propriétaire en génère une nouvelle dans **Équipe & réglages**, ce qui désactive l'ancienne.

| Rôle | Peut |
| --- | --- |
| Membre | Gérer contacts, segments, templates, séquences et campagnes |
| Administrateur | En plus : boîtes d'envoi, domaines, équipe, effacement de contacts, réglages, journal |
| Propriétaire | En plus : clé API. L'organisation garde toujours au moins un propriétaire |

```bash
# Importer un CSV
curl -X POST localhost:4000/v1/contacts/import -H "x-api-key: dev-key-change-me" \
  -H "content-type: text/csv" --data-binary @contacts.csv

# Vérifier un domaine
curl "localhost:4000/v1/dns-check?domain=monentreprise.ci" -H "x-api-key: dev-key-change-me"

# Ajouter une boîte SMTP
curl -X POST localhost:4000/v1/accounts -H "x-api-key: dev-key-change-me" -H "content-type: application/json" \
  -d '{"email":"awa@monentreprise.ci","fromName":"Awa","smtpHost":"smtp.monhebergeur.com","smtpPort":587,"smtpUser":"awa@monentreprise.ci","smtpPassword":"…","dailyLimit":50}'

# Créer un segment : directeurs ayant cliqué ces 30 derniers jours, hors clients
curl -X POST localhost:4000/v1/segments -H "x-api-key: dev-key-change-me" -H "content-type: application/json" \
  -d '{"name":"Directeurs engagés","rules":{"all":[{"field":"title","op":"contains","value":"directeur"},{"activity":"click","withinDays":30,"has":true},{"not":{"tag":"client","has":true}}]}}'

# Inscrire un segment dans une campagne puis la démarrer
curl -X POST localhost:4000/v1/campaigns/<id>/enroll -H "x-api-key: dev-key-change-me" -H "content-type: application/json" -d '{"segmentId":"<id>"}'
curl -X POST localhost:4000/v1/campaigns/<id>/start -H "x-api-key: dev-key-change-me" -H "content-type: application/json" -d '{}'
```

<details>
<summary>Toutes les routes</summary>

| Méthode | Route | Rôle |
| --- | --- | --- |
| POST | `/auth/signup` · `/auth/login` · `/auth/logout` | Inscription, connexion (renvoie un jeton de session), déconnexion |
| GET / POST | `/auth/invitation/:token` · `/auth/accept-invite` | Lire et accepter une invitation |
| GET / PATCH | `/v1/me` · `/v1/org` | Mon compte (mot de passe) · réglages de l'organisation |
| GET / PATCH / DELETE | `/v1/users` | Équipe, changement de rôle, retrait |
| GET / POST / DELETE | `/v1/invitations` | Invitations en attente |
| POST | `/v1/api-key/rotate` | Nouvelle clé API (propriétaire) |
| GET | `/v1/audit` | Journal d'activité |
| GET | `/v1/dashboard` | Indicateurs sur 30 jours |
| GET / POST | `/v1/contacts` | Lister (filtres `status`, `search`) / créer |
| POST | `/v1/contacts/bulk` | Créer jusqu'à 1 000 contacts |
| POST | `/v1/contacts/import` | Import CSV (corps `text/csv` ou JSON `{csv, mapping?, strategy?, tags?}`) |
| GET | `/v1/contacts/:id/export` | Droit d'accès RGPD |
| DELETE | `/v1/contacts/:id` | Droit à l'effacement (l'adresse reste en liste de suppression) |
| GET / POST | `/v1/segments` | Segments dynamiques |
| GET | `/v1/segments/:id/contacts` | Contacts d'un segment |
| GET / POST | `/v1/templates` | Templates (retour : variables détectées, analyse anti-spam) |
| POST | `/v1/templates/preview` | Aperçu rendu |
| GET / POST | `/v1/workflows` | Séquences (graphe validé : départ unique, pas de cycle) |
| POST | `/v1/workflows/:id/versions` | Publier une nouvelle version |
| GET / POST | `/v1/campaigns` | Campagnes |
| POST | `/v1/campaigns/:id/enroll` | Inscrire `{contactIds}`, `{segmentId}` ou `{all: true}` |
| POST | `/v1/campaigns/:id/start` · `/pause` | Démarrer / mettre en pause |
| GET | `/v1/campaigns/:id/stats` | Entonnoir et statistiques par étape |
| GET / POST | `/v1/domains` | Domaines d'envoi et leur rapport DNS |
| GET | `/v1/dns-check?domain=` | Vérification ponctuelle |
| GET / POST / PATCH | `/v1/accounts` | Boîtes d'envoi |
| GET | `/o/:token.gif` · `/c/:token` | Pixel d'ouverture, redirection de clic |
| GET / POST | `/u/:token` | Désinscription (page de confirmation / un clic RFC 8058) |
| POST | `/webhooks/bounce` · `/complaint` · `/inbound` · `/ses` | Rebonds, plaintes, réponses, Amazon SES |

</details>

## Tests

```bash
pnpm test        # 57 tests : workflow, rebonds, DNS, templates, segments, fenêtres, warm-up, tracking, chiffrement, CSV, OAuth, DSN, MIME, mots de passe, rôles, API
pnpm typecheck
pnpm build
```

## Mise en production

- Créez les applications OAuth Google et Microsoft et renseignez leurs identifiants : [docs/oauth.md](docs/oauth.md).
- Mettez `ALLOW_SIGNUP=false` si seules vos invitations doivent permettre de créer un compte. Avec plusieurs instances d'API, remplacez la limitation des tentatives de connexion (en mémoire) par un compteur Redis.
- Générez des secrets : `ENCRYPTION_KEY` (`openssl rand -hex 32`), `TRACKING_SECRET`, `WEBHOOK_SECRET`. L'API refuse de démarrer en production avec les valeurs par défaut.
- Images Docker : `docker build --target api .` et `docker build --target worker .`. Le worker se met à l'échelle indépendamment de l'API.
- Exposez l'API sur un domaine de tracking (ex. `t.monentreprise.ci`) et renseignez `API_PUBLIC_URL`.
- Appliquez `packages/db/sql/rls.sql` pour renforcer l'isolation multi-tenant par Row-Level Security.
- Partitionnez la table `events` par mois au-delà de quelques millions de lignes.

## Feuille de route

- [x] Phase 0 — Monorepo, multi-tenant, files de jobs
- [x] Phase 2 — Contacts, import, dédoublonnage, suppression, séquences, scheduler
- [x] Phase 3 (partiel) — Workflow conditionnel, tracking, statistiques, segments
- [x] Connexion Gmail et Microsoft 365 en OAuth, lecture des réponses et rebonds (Gmail, Graph, IMAP)
- [ ] Éditeur visuel de séquences (React Flow) et éditeur de templates
- [ ] Réseau de warm-up entre boîtes et mesure du placement en boîte de réception
- [x] Comptes utilisateurs, sessions, invitations et rôles
- [ ] Envoi automatique des e-mails d'invitation et de réinitialisation du mot de passe
- [ ] Abonnements (Stripe, Mobile Money via CinetPay ou Paystack)
- [ ] Boîte de réception unifiée avec classification IA des réponses

## Avertissement

Ce logiciel encadre l'envoi d'e-mails commerciaux mais ne remplace pas un avis juridique. Vérifiez vos obligations (RGPD, CAN-SPAM, loi ivoirienne n° 2013-450 et déclarations auprès de l'ARTCI) et les conditions d'utilisation de vos fournisseurs de messagerie avant toute campagne. N'utilisez jamais de listes achetées.
