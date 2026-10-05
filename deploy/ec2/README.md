# Deploy Owl Bot on one AWS EC2 t3.small

All three apps run on one server with Docker Compose:

| Service | What | Memory limit |
|---|---|---|
| `web` | Caddy: serves the React app, proxies the API, automatic HTTPS | 128 MB |
| `api` | Node API (one process: API + agent scheduler + WhatsApp) | 800 MB |
| `converter` | Python gRPC service (MarkItDown, code functions) | 512 MB |
| `postgres` | Postgres 17 + pgvector | 400 MB |

Measured idle: about 250 MB in total. `setup.sh` adds 2 GB of swap for builds
and peaks.

Server folder layout:

```
~/apps/owlbot            github.com/Nadeem-Zaidi/owlbot       (this repo)
~/apps/owlbot_frontend   github.com/Nadeem-Zaidi/strix
~/apps/owlbot_python     github.com/Nadeem-Zaidi/owlbot_grpc
```

---

## 0. Before you start

1. **Rotate any keys that have been exposed.** The AWS access key and OpenAI key
   from earlier sessions count. Delete the `VITE_AWS_*` lines from the
   frontend's `.env`; the web app doesn't use them.
2. **Commit and push all three repos.** The server deploys what's on GitHub.

## 1. Launch the instance

EC2 console → **Launch instance**:

- **Name**: `owlbot`
- **Image**: Ubuntu Server 24.04 LTS (x86_64)
- **Instance type**: `t3.small`
- **Key pair**: create one and download the `.pem`
- **Network**: create a security group with these rules:
  - SSH (22): **My IP** only
  - HTTP (80): Anywhere. Let's Encrypt needs it to issue the certificate.
  - HTTPS (443): Anywhere
- **Storage**: 30 GB gp3
- **Region**: the same one as your S3 bucket, so file traffic stays inside AWS.

## 2. Give the server S3 access with a role (no keys)

1. IAM → **Policies** → Create policy → JSON. Replace the bucket name if yours differs:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::nadeem-bucket-9891" },
       { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::nadeem-bucket-9891/*" }
     ]
   }
   ```

   Name it `owlbot-s3`.
2. IAM → **Roles** → Create role → trusted entity **EC2** → attach `owlbot-s3` →
   name it `owlbot-ec2`.
3. EC2 → your instance → **Actions → Security → Modify IAM role** → `owlbot-ec2`.

Leave `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` empty in `.env`. The app
then uses this role automatically.

## 3. Fixed IP and a domain

1. EC2 → **Elastic IPs** → Allocate → **Associate** it with the instance. Note the IP.
2. Point a domain at it: add an **A record** for `owlbot.yourdomain.com` → the
   Elastic IP.
   - No domain yet? Use `<ip-with-dashes>.sslip.io`, e.g. `13-233-10-20.sslip.io`.
     It resolves to your IP and works with HTTPS.

## 4. Prepare the server

```bash
ssh -i owlbot.pem ubuntu@<elastic-ip>
curl -fsSLO https://raw.githubusercontent.com/Nadeem-Zaidi/owlbot/main/deploy/ec2/setup.sh
bash setup.sh
exit            # log back in so docker works without sudo
```

If the repo is private, copy `setup.sh` over instead:
`scp -i owlbot.pem deploy/ec2/setup.sh ubuntu@<ip>:`

## 5. Get the code

```bash
cd ~/apps
git clone https://github.com/Nadeem-Zaidi/owlbot.git owlbot
git clone https://github.com/Nadeem-Zaidi/strix.git owlbot_frontend
git clone https://github.com/Nadeem-Zaidi/owlbot_grpc.git owlbot_python
```

**Private repos**: create an SSH key on the server and add it to your GitHub
account:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Paste the output in GitHub → Settings → **SSH and GPG keys** → New SSH key.
Then clone with the `git@github.com:Nadeem-Zaidi/<repo>.git` URLs instead.

## 6. Configure

```bash
cd ~/apps/owlbot/deploy/ec2
cp .env.example .env
chmod 600 .env
nano .env
```

Fill in:

- `DOMAIN`, `WEB_APP_URL`, `CORS_ORIGINS`: your domain from step 3.
- `POSTGRES_PASSWORD`: generate with `openssl rand -hex 24`.
- `AGENT_SECRETS_KEY`: generate with `openssl rand -hex 32`. **Save a copy
  somewhere safe.** If it's lost, secrets saved on agents can't be decrypted.
- `FIREBASE_SERVICE_ACCOUNT_BASE64`: generate on your PC. In Git Bash, from the
  owlbot folder:

  ```bash
  base64 -w0 src/authentication/serviceAccountKey.json
  ```

  Paste the output.
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OWNER_EMAILS`, `AWS_REGION`, `S3_BUCKET`.

## 7. Deploy

```bash
cd ~/apps/owlbot/deploy/ec2
bash deploy.sh
```

The first build takes about 10–15 minutes on a t3.small. Database migrations run
automatically. Open `https://<your-domain>`; the certificate is issued on the
first visit.

## 8. Finish the setup

- **Firebase**: console → Authentication → Settings → **Authorized domains** →
  add your domain. Without this, Google and phone sign-in fail.
- **Razorpay** (if billing is on): set the webhook URL to
  `https://<domain>/api/billing/webhook`.
- **Backups**: run `crontab -e` and add:

  ```
  0 3 * * * /home/ubuntu/apps/owlbot/deploy/ec2/backup.sh >> /home/ubuntu/owlbot-backup.log 2>&1
  ```

  Optionally add `BACKUP_S3_URI=s3://<bucket>/owlbot-backups/` to `.env`, and
  `s3:PutObject` on that prefix to the role.

## Move your existing data (optional)

Files are already in S3. Only the database needs moving. On your PC:

```bash
pg_dump -h localhost -U postgres -d testerp --no-owner | gzip > owlbot.sql.gz
scp -i owlbot.pem owlbot.sql.gz ubuntu@<ip>:~/apps/owlbot/deploy/ec2/backups/
```

On the server, after step 7. This replaces the empty tables created by the first
start:

```bash
cd ~/apps/owlbot/deploy/ec2
docker compose stop api
docker compose exec -T postgres psql -U owlbot -d owlbot -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
gunzip -c backups/owlbot.sql.gz | docker compose exec -T postgres psql -U owlbot -d owlbot
docker compose start api
```

## Everyday commands

All commands run from `~/apps/owlbot/deploy/ec2`.

| Task | Command |
|---|---|
| Ship new code (after `git push`) | `bash deploy.sh` |
| Rebuild without pulling | `bash deploy.sh --no-pull` |
| Status | `docker compose ps` |
| Logs | `docker compose logs -f api` (or `web`, `converter`, `postgres`) |
| Restart one service | `docker compose restart api` |
| Database shell | `docker compose exec postgres psql -U owlbot -d owlbot` |
| Memory and disk | `docker stats --no-stream`, `df -h` |

## Troubleshooting

- **No HTTPS / "connection refused"**
  - Check that the DNS A record points at the Elastic IP (`nslookup <domain>`).
  - Check that ports 80 and 443 are open in the security group.
  - Run `docker compose logs web`.
- **Build killed or very slow**: check that swap is on (`swapon --show`). `deploy.sh`
  already builds one image at a time.
- **502 from the site**: the API isn't up. Run `docker compose logs api`. A missing
  `.env` value, such as `AGENT_SECRETS_KEY` or the Firebase key, stops it at start.
- **Sign-in fails**: the domain isn't in Firebase's Authorized domains, or you're on
  plain HTTP.
- **Uploads fail**: the instance role is missing, or the bucket name or region is
  wrong.

## Cost and limits

- A t3.small on-demand instance is roughly **US$15–20 a month** with 30 GB of
  storage, depending on region.
- t3 instances run on CPU credits. Long builds use them up. "Unlimited" mode (the
  default for t3) bills extra if you stay above the baseline for long.
- This setup suits personal use and small teams. For more users, use the scaled
  stack in `../../docker-compose.prod.yml` (load balancer, several API instances,
  Redis, PgBouncer) on bigger instances, or move Postgres to RDS.
