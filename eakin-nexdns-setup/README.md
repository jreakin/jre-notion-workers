# eakin-nexdns-setup

NextDNS configuration and deployment for Ubiquiti Dream Machine sites.

## Structure

```
sites/          # Per-site NextDNS configs and documentation
  brownsville/  # Brownsville site
  parents/      # Parents site
shared/         # Common templates and base configs
scripts/        # Deploy and backup automation
```

## Usage

```bash
# Deploy config to a site
./scripts/deploy.sh <site-name>

# Backup current config from UDM
./scripts/backup.sh <site-name>
```
