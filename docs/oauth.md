# Connecter Gmail et Microsoft 365 (OAuth)

Les boîtes Google Workspace et Microsoft 365 se connectent en un clic depuis la page **Boîtes d'envoi**.
Il faut d'abord créer une application OAuth chez chaque fournisseur et renseigner ses identifiants dans `.env`.

L'adresse de retour est toujours : `{API_PUBLIC_URL}/oauth/{fournisseur}/callback`

| Fournisseur | Adresse de retour en local |
| --- | --- |
| Google | `http://localhost:4000/oauth/gmail/callback` |
| Microsoft | `http://localhost:4000/oauth/outlook/callback` |

En production, `API_PUBLIC_URL` doit être en HTTPS, et `WEB_URL` doit pointer vers l'interface.

## Google Workspace

1. Dans la [Google Cloud Console](https://console.cloud.google.com/), créez un projet.
2. **API et services → Bibliothèque** : activez **Gmail API**.
3. **Écran de consentement OAuth** :
   - type **Interne** si seules les boîtes de votre propre organisation Google Workspace seront connectées (pas de vérification Google) ;
   - type **Externe** pour connecter les boîtes de vos clients. Ajoutez les scopes ci-dessous et vos comptes de test tant que l'application n'est pas vérifiée.
4. **Identifiants → Créer des identifiants → ID client OAuth**, type **Application Web**, avec l'adresse de retour ci-dessus.
5. Copiez l'ID et le secret dans `.env` :

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=…
```

Scopes demandés : `gmail.send` (envoi) et `gmail.readonly` (détection des réponses et des rebonds), plus `openid` et `email`.

> `gmail.readonly` est classé « restreint » par Google. Pour ouvrir l'application à des clients extérieurs
> au-delà des comptes de test, Google exige une vérification de l'application, qui inclut une évaluation
> de sécurité pour les scopes restreints. Prévoyez ce délai avant le lancement commercial et vérifiez les
> exigences en vigueur dans la console Google Cloud.

## Microsoft 365

1. Dans le [centre d'administration Microsoft Entra](https://entra.microsoft.com/), **Applications → Inscriptions d'applications → Nouvelle inscription**.
2. Types de comptes : **comptes dans un annuaire d'organisation (multilocataire)** pour connecter les boîtes de plusieurs entreprises.
3. URI de redirection : plateforme **Web**, adresse de retour ci-dessus.
4. **Certificats et secrets → Nouveau secret client** : copiez la **valeur** (elle n'est affichée qu'une fois).
5. **Autorisations d'API → Microsoft Graph → Autorisations déléguées** : `Mail.Send`, `Mail.Read`, `User.Read`, `offline_access`, `openid`, `email`.
6. Dans `.env` :

```
MICROSOFT_CLIENT_ID=<ID d'application (client)>
MICROSOFT_CLIENT_SECRET=<valeur du secret>
```

Certaines organisations exigent le consentement d'un administrateur : l'administrateur du client accepte alors l'application une fois pour tout son annuaire.

## Ce qui se passe ensuite

- Les jetons sont chiffrés (AES-256-GCM avec `ENCRYPTION_KEY`) et rafraîchis automatiquement avant expiration.
- Les envois partent par l'API Gmail ou Microsoft Graph avec un MIME identique à celui du SMTP : même `Message-ID`, même fil, mêmes en-têtes de désinscription.
- Toutes les 2 minutes (`INBOX_SYNC_INTERVAL_MS`), le worker lit les messages reçus et rattache aux e-mails envoyés :
  - les **réponses** (arrêt de la séquence pour ce contact) ;
  - les **réponses automatiques** (absence : la séquence continue) ;
  - les **rebonds** (rapports de non-remise : contact en rebond et liste de suppression si définitif).
- Si l'utilisateur retire l'accès chez Google ou Microsoft, la boîte est mise en pause et marquée **Reconnexion nécessaire**. La reconnecter conserve son historique de warm-up.

## Autres hébergeurs (SMTP + IMAP)

Pour OVH, Zoho, cPanel et autres, ajoutez la boîte par l'API en précisant le serveur IMAP : les réponses et rebonds seront lus de la même façon.

```bash
curl -X POST localhost:4000/v1/accounts -H "x-api-key: …" -H "content-type: application/json" -d '{
  "email": "awa@monentreprise.ci", "fromName": "Awa",
  "smtpHost": "ssl0.ovh.net", "smtpPort": 465, "smtpSecure": true,
  "smtpUser": "awa@monentreprise.ci", "smtpPassword": "…",
  "imapHost": "ssl0.ovh.net", "imapPort": 993
}'
```
