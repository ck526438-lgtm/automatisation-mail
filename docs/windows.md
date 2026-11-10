# Application Windows

Automatisation Mail existe en application Windows **autonome** : tout fonctionne sur le PC, sans serveur ni abonnement d'hébergement.
La base de données, le moteur d'envoi, la lecture des boîtes et l'interface sont embarqués dans l'installateur.

## Installer

1. Téléchargez `Automatisation-Mail-Setup-x.y.z.exe` dans les [versions du dépôt](https://github.com/ck526438-lgtm/automatisation-mail/releases)
   (ou dans les artefacts de la dernière exécution « Application Windows » de GitHub Actions).
2. Lancez l'installateur et suivez les étapes. Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » tant que
   l'installateur n'est pas signé : **Informations complémentaires → Exécuter quand même**.
3. L'application s'ouvre directement, sans écran de connexion : vous êtes propriétaire de votre espace sur ce poste.

## Premiers pas

Le tableau de bord affiche une liste **Pour commencer** :

1. **Équipe & réglages** : nom de l'entreprise et adresse postale (obligatoire au pied de chaque e-mail).
2. **Boîtes d'envoi** : connectez une boîte (Google, Microsoft ou SMTP + IMAP, voir plus bas).
3. **Équipe & réglages → E-mails système** : un SMTP dédié (Brevo, Resend, Mailjet, OVH, Zoho…) pour les e-mails automatiques
   de la plateforme : alertes « campagne mise en pause », « boîte à reconnecter », « mot de passe modifié ». Bouton de test inclus.
4. **Contacts** : importez un CSV.
5. **Campagnes** : inscrivez les contacts et démarrez.

## Comment ça tourne

- **Fermer la fenêtre ne coupe pas les envois** : l'application reste dans la zone de notification (près de l'horloge).
  Clic droit sur l'icône : **Ouvrir**, **Démarrer avec Windows**, **Ouvrir le dossier des données**, **Quitter**.
- **Les envois s'arrêtent quand le PC est éteint ou que l'application est quittée.** Rien n'est perdu : les e-mails dus partent à la
  réouverture, en respectant toujours les fenêtres horaires, les quotas et le warm-up. Cochez « Démarrer avec Windows ».
- Les données sont dans `%APPDATA%\Automatisation Mail` : base (`base\`), journal (`automatisation-mail.log`), secrets chiffrés par
  Windows (`secrets.bin`). **Sauvegardez ce dossier** (application quittée) pour ne rien perdre en cas de changement de PC.
- Désinstaller l'application conserve ce dossier.

## Différences avec la version serveur

| | Application Windows | Version serveur |
| --- | --- | --- |
| Hébergement | Aucun | Serveur avec PostgreSQL et Redis |
| Envois | Quand le PC est allumé | 24 h/24 |
| Utilisateurs | Une personne, sur ce poste | Équipe, invitations, rôles |
| Désinscription | Réponse « STOP » ou lien mailto, détectés automatiquement | Lien en un clic (RFC 8058) + réponse « STOP » |
| Suivi des ouvertures et des clics | Désactivé (le PC n'est pas joignable depuis Internet) | Actif, sur votre domaine de suivi |
| Réponses, absences, rebonds | Lus automatiquement | Lus automatiquement |

Sans adresse publique, les destinataires ne peuvent pas joindre votre PC : l'application n'insère donc **aucun lien vers le poste**
dans les e-mails. Chaque message propose de répondre « STOP », et l'en-tête `List-Unsubscribe` pointe vers votre boîte en `mailto:`.
Ces demandes sont détectées à la lecture des boîtes : le contact est désinscrit et ajouté à la liste de suppression.

> Gmail et Yahoo exigent la désinscription « en un clic » (lien HTTPS) pour les expéditeurs de plus de 5 000 e-mails par jour.
> En prospection depuis une boîte professionnelle, vous êtes très en dessous ; au-delà, utilisez la version serveur.

## Connecter Gmail ou Microsoft 365

Il faut une application OAuth à votre nom, comme pour la version serveur ([docs/oauth.md](oauth.md)), avec deux différences :

- **Google** : créez un ID client de type **Application de bureau** (pas « Application Web ») : Google accepte alors l'adresse de retour
  locale de l'application.
- **Microsoft** : ajoutez l'URI de redirection `http://localhost:47811/oauth/outlook/callback` (plateforme **Web**).

Placez ensuite les identifiants dans `%APPDATA%\Automatisation Mail\config.json`, puis relancez l'application :

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

## Construire l'installateur

L'installateur est construit automatiquement par GitHub Actions (workflow **Application Windows**) à chaque push sur `main`, et
publié dans les versions du dépôt à chaque tag `v*`. Le workflow lance d'abord le test de bout en bout sous Windows.

En local, sous Windows :

```bash
pnpm install
pnpm --filter @am/desktop stage    # prépare apps/desktop/stage (interface, base, moteur)
pnpm --filter @am/desktop smoke    # test de bout en bout : envoi, e-mails système, redémarrage
cd apps/desktop && npx electron-builder --config electron-builder.json --win --x64
```

Sous Linux ou macOS, `electron-builder --win` a besoin de Wine pour produire l'installateur.
