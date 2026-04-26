# Auto-start WikiChat

WikiChat est conçu pour tourner en service permanent : il démarre quand tu te connectes à ta machine et reste en arrière-plan.

## Installation automatique (recommandé)

```bash
npm run install-service
```

Le script détecte ton OS et configure le mécanisme natif :

| OS | Mécanisme | Configuration |
|---|---|---|
| Windows | Task Scheduler | tâche `WikiChat`, déclenchée à chaque logon de l'utilisateur |
| macOS | launchd | LaunchAgent `~/Library/LaunchAgents/com.wikichat.plist` |
| Linux | systemd --user | unit `~/.config/systemd/user/wikichat.service` |

Idempotent — relancer `install-service` met à jour proprement la config existante.

## Désinstallation

```bash
npm run uninstall-service
```

## Vérifier que ça tourne

```bash
curl http://localhost:3777/api/health
```

Tu dois recevoir `{"status":"healthy",...}`.

## Logs

| OS | Emplacement |
|---|---|
| Windows | Task Scheduler → Onglet "Historique" |
| macOS | `~/.wikichat/stdout.log` et `stderr.log` |
| Linux | `journalctl --user -u wikichat -f` |

## Désactiver temporairement sans désinstaller

| OS | Commande |
|---|---|
| Windows | `schtasks /Change /TN WikiChat /Disable` |
| macOS | `launchctl unload ~/Library/LaunchAgents/com.wikichat.plist` |
| Linux | `systemctl --user stop wikichat` (et `disable` si permanent) |

## Configuration manuelle si l'auto-installer ne couvre pas ton cas

### Windows — installation manuelle Task Scheduler

```powershell
$node = (Get-Command node).Source
$server = "C:\path\to\wikichat\server.mjs"
schtasks /Create /TN "WikiChat" /TR "`"$node`" `"$server`"" /SC ONLOGON /RL HIGHEST /F
```

### macOS — sans script

Crée `~/Library/LaunchAgents/com.wikichat.plist` :

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.wikichat</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/wikichat/server.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
```

Puis : `launchctl load ~/Library/LaunchAgents/com.wikichat.plist`

### Linux — sans script

Crée `~/.config/systemd/user/wikichat.service` :

```ini
[Unit]
Description=WikiChat
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/wikichat
ExecStart=/usr/bin/node server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

Puis :

```bash
systemctl --user daemon-reload
systemctl --user enable --now wikichat.service
```

## Variables d'environnement

Pour passer des variables à ton service auto-start, édite la config OS :

- Windows : Task Scheduler → propriétés de la tâche → "Actions" → ajoute `--env`
- macOS : `<key>EnvironmentVariables</key><dict>...</dict>` dans le plist
- Linux : `Environment="KEY=value"` dans la section `[Service]`

Variables utiles :
- `PORT=3777`
- `HOST=127.0.0.1`
- `WIKICHAT_MAX_SESSIONS=10`
- `WIKICHAT_PRINCIPAL_AGENT=Claude-Code`
- `WIKICHAT_AUTONOMOUS_TEAM=1` (opt-in équipe résidente)
