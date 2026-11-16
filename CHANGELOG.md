# Journal des modifications

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/). Les numéros de version sont ceux de l'application
de bureau (`apps/desktop/package.json`).

## [0.5.0] — 2026-11-16

### Ajouté
- **Application macOS** (`.dmg`, puce Apple et Intel) : menu en français, icône dans la barre des menus, ouverture à l'ouverture de session.
- **Application Linux** (`.AppImage` et `.deb`, x64) : démarrage automatique par entrée XDG Autostart.
- **Application mobile installable** (Android, iPhone, iPad, ChromeOS) pour la version serveur : manifeste, icônes, raccourcis,
  page « hors connexion », zones sûres et champs adaptés au tactile.
- Menu de l'icône : **Ouvrir le journal**, **Aide**, **Rechercher une mise à jour**.
- Publication automatique : une nouvelle version dans `apps/desktop/package.json` fusionnée dans `main` crée le tag et la version GitHub.
- Sommes de contrôle `SHA256SUMS.txt` jointes à chaque version publiée.
- Guide [docs/applications.md](docs/applications.md), guide de contribution, politique de sécurité, modèles d'issues et de pull request.

### Modifié
- Le workflow « Application Windows » devient **Applications de bureau** : construction et test de bout en bout sur Windows, macOS et
  Linux, y compris sur les pull requests.
- `docs/windows.md` est remplacé par `docs/applications.md`.

### Corrigé
- Les modules de l'interface embarquée sont désormais copiés « à plat », sans lien symbolique : l'application installée ne dépend
  plus du dossier de construction (les liens de pnpm restaient pointés vers lui) et le paquet macOS peut être signé.

## [0.4.0]

- Application Windows autonome (base embarquée PGlite, API, moteur et interface sur le poste).
- E-mails système automatiques par SMTP dédié (invitation, mot de passe oublié, alertes).
