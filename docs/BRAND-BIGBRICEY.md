# Brand: BigBricey

**Public product name:** BigBricey  
**Primary domain (target):** https://www.bigbricey.com  
**Legacy domain (still works until DNS cutover):** https://www.fitnessfixzone.com  

## Why
- Your name → no Theokoles / Spartacus brand risk  
- You already own bigbricey.com  
- Product is personal forever health/food ledger + coach  

## Vercel
- Project: `fitnessfixzone` (can rename later; folder can stay `nutri-table`)  
- Domains added: `bigbricey.com`, `www.bigbricey.com`  
- **DNS still InMotion** — point to Vercel:

### DNS (Namecheap / InMotion)
For `bigbricey.com` and `www`:

| Type | Host | Value |
|------|------|--------|
| A | @ | `76.76.21.21` |
| CNAME | www | `cname.vercel-dns.com` |

Or switch nameservers to Vercel’s if you prefer.

## Google OAuth (required for login on new domain)
In Google Cloud Console → OAuth Web client, add **Authorized redirect URIs**:

- `https://www.bigbricey.com/api/auth/callback`
- `https://bigbricey.com/api/auth/callback`

Keep existing fitnessfixzone callback until that domain is retired.

Authorized JavaScript origins:

- `https://www.bigbricey.com`
- `https://bigbricey.com`

## App code
- User-facing strings → **BigBricey**  
- `siteUrl()` uses **request host** so both domains OAuth correctly  
- Session cookie: `bigbricey_session`  
- Local day key: `bigbricey-day-`  

## Forwarding later
fitnessfixzone.com / theokoles.ai → redirect to bigbricey.com when ready.
