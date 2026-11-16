# Politique de sécurité

## Signaler une vulnérabilité

**N'ouvrez pas d'issue publique.** Utilisez le signalement privé de GitHub :
[Security → Report a vulnerability](https://github.com/ck526438-lgtm/automatisation-mail/security/advisories/new).

Indiquez la version concernée (application de bureau ou version serveur), les étapes pour reproduire et l'impact constaté.
Vous recevrez une réponse dès que possible ; merci de laisser le temps de publier un correctif avant toute divulgation.

## Versions prises en charge

Seule la dernière version publiée reçoit des correctifs de sécurité.

## Ce qui protège vos données

- Mots de passe hachés avec scrypt ; sessions en cookie `httpOnly` ; blocage après 5 essais.
- Jetons OAuth et mots de passe SMTP/IMAP chiffrés en base (AES-256-GCM, clé `ENCRYPTION_KEY`).
- Application de bureau : API et interface n'écoutent que sur `127.0.0.1` ; les secrets du poste sont chiffrés par le système
  (DPAPI, Trousseau macOS, libsecret/KWallet).
- Version serveur : l'API refuse de démarrer en production avec les secrets par défaut ; isolation multi-tenant renforçable par
  Row-Level Security (`packages/db/sql/rls.sql`).
- Jetons de tracking et de désinscription signés (HMAC).
