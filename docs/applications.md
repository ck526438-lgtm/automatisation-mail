# Applications : Windows, macOS, Linux, Android et iOS

Automatisation Mail s'utilise de deux façons :

| | Application de bureau | Application mobile |
| --- | --- | --- |
| Systèmes | Windows 10/11, macOS 11+, Linux (x64) | Android, iPhone, iPad, ChromeOS |
| Principe | **Autonome** : base, moteur d'envoi et interface tournent sur le poste, sans serveur | Interface de la **version serveur**, installée sur l'écran d'accueil |
| Il faut | Rien d'autre que l'installateur | Une version serveur en ligne, en HTTPS |

## Télécharger l'application de bureau

Les installateurs sont dans les [versions du dépôt](https://github.com/ck526438-lgtm/automatisation-mail/releases/latest)
(ou dans les artefacts de la dernière exécution « Applications de bureau » de GitHub Actions).

| Système | Fichier |
| --- | --- |
| Windows 10 / 11 (64 bits) | `Automatisation-Mail-Setup-x.y.z.exe` |
| macOS, puce Apple (M1 et suivantes) | `Automatisation-Mail-x.y.z-mac-arm64.dmg` |
| macOS, processeur Intel | `Automatisation-Mail-x.y.z-mac-x64.dmg` |
| Ubuntu, Debian, Linux Mint | `Automatisation-Mail-x.y.z-linux-amd64.deb` |
| Autres distributions Linux | `Automatisation-Mail-x.y.z-linux-x86_64.AppImage` |

`SHA256SUMS.txt` permet de vérifier un téléchargement (`sha256sum -c SHA256SUMS.txt`).

### Windows

1. Lancez `Automatisation-Mail-Setup-x.y.z.exe` et suivez les étapes.
2. Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » tant que l'installateur n'est pas signé :
   **Informations complémentaires → Exécuter quand même**.

### macOS

1. Ouvrez le `.dmg` et glissez **Automatisation Mail** dans **Applications**.
2. L'application n'est pas notarisée par Apple (il faut pour cela un compte Apple Developer payant). Au premier lancement,
   macOS la bloque : ouvrez **Réglages Système → Confidentialité et sécurité**, puis cliquez **Ouvrir quand même**
   en face d'Automatisation Mail. Sur macOS 14 et antérieurs, un clic droit sur l'application → **Ouvrir** suffit.
3. Si macOS affiche « l'application est endommagée », levez la quarantaine dans le Terminal :
   `xattr -cr "/Applications/Automatisation Mail.app"`

### Linux

- **Debian, Ubuntu, Mint** : `sudo apt install ./Automatisation-Mail-x.y.z-linux-amd64.deb`, puis lancez l'application depuis le menu.
- **AppImage** (toutes distributions) : `chmod +x Automatisation-Mail-*.AppImage` puis double-clic.
  Sur Ubuntu 22.04 et suivantes, installez d'abord FUSE : `sudo apt install libfuse2` (`libfuse2t64` sur Ubuntu 24.04).
- **GNOME** n'affiche pas la zone de notification par défaut : installez l'extension
  [AppIndicator](https://extensions.gnome.org/extension/615/appindicator-support/) pour voir l'icône. Sans elle, l'application
  continue de tourner fenêtre fermée ; relancez-la depuis le menu pour rouvrir la fenêtre.

L'application s'ouvre directement, sans écran de connexion : vous êtes propriétaire de votre espace sur ce poste.

## Premiers pas

Le tableau de bord affiche une liste **Pour commencer** :

1. **Équipe & réglages** : nom de l'entreprise et adresse postale (obligatoire au pied de chaque e-mail).
2. **Boîtes d'envoi** : connectez une boîte (Google, Microsoft ou SMTP + IMAP, voir plus bas).
3. **Équipe & réglages → E-mails système** : un SMTP dédié (Brevo, Resend, Mailjet, OVH, Zoho…) pour les e-mails automatiques
   de la plateforme : alertes « campagne mise en pause », « boîte à reconnecter », « mot de passe modifié ». Bouton de test inclus.
4. **Contacts** : importez un CSV.
5. **Campagnes** : inscrivez les contacts et démarrez.

## Comment ça tourne

- **Fermer la fenêtre ne coupe pas les envois** : l'application reste dans la zone de notification (près de l'horloge sous Windows et
  Linux, dans la barre des menus sous macOS). Le menu de l'icône propose : **Ouvrir**, **Démarrer à l'ouverture de session**,
  **Ouvrir le dossier des données**, **Ouvrir le journal**, **Rechercher une mise à jour**, **Quitter**.
- **Les envois s'arrêtent quand l'ordinateur est éteint ou en veille, ou que l'application est quittée.** Rien n'est perdu : les
  e-mails dus partent à la réouverture, en respectant toujours les fenêtres horaires, les quotas et le warm-up.
  Cochez le démarrage à l'ouverture de session.
- Les données restent sur le poste. **Sauvegardez ce dossier** (application quittée) pour ne rien perdre en changeant d'ordinateur :

  | Système | Dossier des données |
  | --- | --- |
  | Windows | `%APPDATA%\Automatisation Mail` |
  | macOS | `~/Library/Application Support/Automatisation Mail` |
  | Linux | `~/.config/Automatisation Mail` |

  Il contient la base (`base/`), le journal (`automatisation-mail.log`), les réglages facultatifs (`config.json`) et les secrets
  (`secrets.bin`), chiffrés par le système : DPAPI sous Windows, Trousseau sous macOS, libsecret ou KWallet sous Linux
  (en clair si aucun trousseau n'est disponible).
- Les secrets étant liés à la session du système, copier le dossier vers un **autre** ordinateur demande de reconnecter les boîtes d'envoi.
- Désinstaller l'application conserve ce dossier.
- **Mises à jour** : téléchargez le nouvel installateur et installez-le par-dessus ; les données sont conservées.

## Différences avec la version serveur

| | Application de bureau | Version serveur |
| --- | --- | --- |
| Hébergement | Aucun | Serveur avec PostgreSQL et Redis |
| Envois | Quand l'ordinateur est allumé | 24 h/24 |
| Utilisateurs | Une personne, sur ce poste | Équipe, invitations, rôles |
| Accès depuis un téléphone | Non | Oui, application installable (voir plus bas) |
| Désinscription | Réponse « STOP » ou lien mailto, détectés automatiquement | Lien en un clic (RFC 8058) + réponse « STOP » |
| Suivi des ouvertures et des clics | Désactivé (le poste n'est pas joignable depuis Internet) | Actif, sur votre domaine de suivi |
| Réponses, absences, rebonds | Lus automatiquement | Lus automatiquement |

Sans adresse publique, les destinataires ne peuvent pas joindre votre ordinateur : l'application n'insère donc **aucun lien vers le
poste** dans les e-mails. Chaque message propose de répondre « STOP », et l'en-tête `List-Unsubscribe` pointe vers votre boîte en
`mailto:`. Ces demandes sont détectées à la lecture des boîtes : le contact est désinscrit et ajouté à la liste de suppression.

> Gmail et Yahoo exigent la désinscription « en un clic » (lien HTTPS) pour les expéditeurs de plus de 5 000 e-mails par jour.
> En prospection depuis une boîte professionnelle, vous êtes très en dessous ; au-delà, utilisez la version serveur.

## Connecter Gmail ou Microsoft 365

Il faut une application OAuth à votre nom, comme pour la version serveur ([oauth.md](oauth.md)), avec deux différences :

- **Google** : créez un ID client de type **Application de bureau** (pas « Application Web ») : Google accepte alors l'adresse de retour
  locale de l'application.
- **Microsoft** : ajoutez l'URI de redirection `http://localhost:47811/oauth/outlook/callback` (plateforme **Web**).

Placez ensuite les identifiants dans `config.json`, dans le dossier des données, puis relancez l'application :

```json
{
  "GOOGLE_CLIENT_ID": "…apps.googleusercontent.com",
  "GOOGLE_CLIENT_SECRET": "…",
  "MICROSOFT_CLIENT_ID": "…",
  "MICROSOFT_CLIENT_SECRET": "…"
}
```

Le consentement Google ou Microsoft s'ouvre dans votre navigateur habituel (ils refusent les fenêtres intégrées). Une fois la page
« Boîte connectée » affichée, revenez dans l'application : la liste des boîtes se met à jour.

Les boîtes d'autres hébergeurs (OVH, Zoho, cPanel…) s'ajoutent en SMTP + IMAP, sans application OAuth.

## Android, iPhone et iPad

Un téléphone ne peut pas faire tourner le moteur d'envoi en continu (le système met les applications en veille). Sur mobile,
Automatisation Mail est donc l'interface de votre **version serveur**, installable comme une application : icône sur l'écran d'accueil,
plein écran, raccourcis vers Campagnes, Contacts et Boîtes d'envoi, page « hors connexion ».

Prérequis : l'interface de la version serveur est en ligne en **HTTPS** (voir « Mise en production » dans le [README](../README.md)).

- **Android (Chrome, Edge, Samsung Internet)** : ouvrez l'adresse de votre interface, puis menu **⋮ → Installer l'application**
  (ou **Ajouter à l'écran d'accueil**).
- **iPhone / iPad (Safari)** : ouvrez l'adresse, touchez **Partager → Sur l'écran d'accueil**.
- **Ordinateur (Chrome, Edge)** : icône d'installation dans la barre d'adresse.

Aucune donnée (contacts, campagnes) n'est mise en cache sur le téléphone : tout reste sur votre serveur.

L'application de bureau autonome, elle, n'est pas joignable depuis un téléphone : elle n'écoute que sur le poste (`127.0.0.1`).

## Construire les installateurs

Ils sont construits par GitHub Actions (workflow **Applications de bureau**) à chaque push sur `main` et pour chaque pull request,
après un test de bout en bout sur les trois systèmes. Pour publier une version :

```bash
# 1. Mettre à jour "version" dans apps/desktop/package.json et CHANGELOG.md, fusionner dans main
# 2. Poser le tag
git tag v0.5.0 && git push origin v0.5.0
```

Le workflow crée alors la version GitHub avec les cinq installateurs et `SHA256SUMS.txt`.

En local, chaque système construit son propre installateur :

```bash
pnpm install
pnpm --filter @am/desktop stage    # prépare apps/desktop/stage (interface, base, moteur)
pnpm --filter @am/desktop smoke    # test de bout en bout : envoi, e-mails système, redémarrage
cd apps/desktop
npx electron-builder --config electron-builder.json --win     # sous Windows
npx electron-builder --config electron-builder.json --mac     # sous macOS
npx electron-builder --config electron-builder.json --linux   # sous Linux
```

### Signature

Les installateurs ne sont pas signés par défaut, d'où les avertissements de SmartScreen et de Gatekeeper.

- **macOS** : sans certificat, l'application reçoit une signature « ad hoc » (`scripts/after-pack.cjs`), indispensable sur puce Apple.
  Avec un compte Apple Developer : retirez `"identity": null` d'`electron-builder.json`, retirez `CSC_IDENTITY_AUTO_DISCOVERY` du
  workflow et ajoutez les secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` et `APPLE_TEAM_ID`.
- **Windows** : avec un certificat de signature de code, ajoutez les secrets `CSC_LINK` et `CSC_KEY_PASSWORD`.
