# hfy-api cost estimate (HFY-TSK-063, AC3)

Scope: the incremental cost of the app backend (app-stack.yaml plus the /api/* behavior) for about 40 active family members. The existing static site (S3, CloudFront, auth edge) is excluded. Prices are us-east-1 list prices, to be re-checked at deploy time.

## Traffic model

40 members x 20 sessions/month x 15 API calls = 12,000 requests. Rounded up 8x for polling, retries and bots: **100,000 requests/month** (90% reads, 10% writes), roughly 5,000 write operations.

| Item | Basis | Monthly USD |
| --- | --- | --- |
| DynamoDB reads | 90k reads x ~2 RRU = 180k RRU at $0.125/M | 0.02 |
| DynamoDB writes | 5k transactional writes x ~10 WRU = 50k WRU at $0.625/M | 0.03 |
| DynamoDB storage + PITR | under 0.2 GB at $0.25 + $0.20 per GB | 0.10 |
| Lambda (arm64, 256 MB) | 100k x 150 ms = 3.75k GB-s at $0.0000133/GB-s, plus $0.20/M requests | 0.07 |
| CloudFront | 100k HTTPS requests at $0.01/10k; transfer within the 1 TB free tier | 0.10 |
| Secrets Manager | session key + VAPID secret, $0.40 each | 0.80 |
| CloudWatch Logs | about 0.1 GB at $0.50/GB (30-day retention) | 0.05 |
| **Total** | | **about 1.2 per month, about 14 per year** |

## Stress check

At 5x the traffic (500k requests/month) the usage-driven lines grow to about 1.6 per month; with the fixed 0.85 for secrets and logs the total is about 2.4 per month, **about 29 per year**, still under the 30 USD/year target. Dropping the optional VAPID secret saves a further 4.80 per year.

## What drives cost

Secrets Manager is the largest single line, so the session key is cached in memory per Lambda container and read once. The push fan-out for new posts uses a table Scan on `SUB#` keys; at this size it is a few read units per publish. If the family grows by 10x, replace it with a subscriber index item.
