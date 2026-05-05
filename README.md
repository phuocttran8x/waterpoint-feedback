# Waterpoint Resident Feedback Backend

Node.js + Express + Supabase backend for resident feedback.

## Features

Public APIs:
- Submit feedback with `name`, `units[]`, `content`
- View feedback list with search + pagination
- No personal data in public responses (`name` and `units` are hidden)
- Edit feedback only when ownership is valid:
	- Name must match exactly after normalization
	- At least one submitted unit must match existing units

Admin APIs:
- Login with hashed password (`bcrypt` compare)
- Export anonymized JSON
- Export full internal JSON

Data model:
- `id`
- `name`
- `units[]`
- `content`
- `createdAt`
- `updatedAt`

System requirement:
- Unique participants are computed by normalized `(name + sorted units)`

## 1) Supabase setup

Run SQL from `supabase/schema.sql` in your Supabase SQL editor.

It creates:
- `feedbacks` table
- auto-generated readable IDs (`WP-000001`, ...)
- indexes
- `updated_at` trigger

## 2) Environment variables

Copy `.env.example` to `.env` and fill values:

```bash
NODE_ENV=development
PORT=4000
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ADMIN_PASSWORD_HASH=$2a$10$replace_with_bcrypt_hash
ADMIN_PASSWORD=or_use_plain_password_for_local_dev_only
ADMIN_JWT_SECRET=replace_with_long_random_secret
CORS_ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
```

To generate `ADMIN_PASSWORD_HASH`:

```bash
node -e "console.log(require('bcryptjs').hashSync('your-admin-password', 10))"
```

## 3) Install + run

```bash
npm install
npm run dev
```

Server starts at `http://localhost:4000`.

If `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are not set, the server runs in `in-memory` mode for local testing only.
In production (`NODE_ENV=production`), Supabase credentials are required.

## 4) API reference

### Health

`GET /health`

Response:

```json
{ "ok": true }
```

### Public: submit feedback

`POST /api/feedback`

Request body:

```json
{
	"name": "Nguyen Van A",
	"units": ["AQ1-1205", "RV2-08-12"],
	"content": "Resident feedback content"
}
```

Response (anonymized):

```json
{
	"feedback": {
		"id": "WP-000001",
		"content": "Resident feedback content",
		"createdAt": "2026-05-05T08:10:00.000Z",
		"updatedAt": "2026-05-05T08:10:00.000Z"
	}
}
```

### Public: list feedback

`GET /api/feedback?search=park&page=1&pageSize=10`

Response:

```json
{
	"items": [
		{
			"id": "WP-000001",
			"content": "Resident feedback content",
			"createdAt": "2026-05-05T08:10:00.000Z",
			"updatedAt": "2026-05-05T08:10:00.000Z"
		}
	],
	"pagination": {
		"page": 1,
		"pageSize": 10,
		"totalItems": 20,
		"totalPages": 2
	},
	"stats": {
		"uniqueParticipants": 15
	}
}
```

### Public: edit feedback (ownership required)

`PUT /api/feedback/:id`

Request body:

```json
{
	"name": "Nguyen Van A",
	"units": ["RV2-08-12"],
	"content": "Updated content"
}
```

Rules:
- Name must match the original submitter
- At least one unit must overlap with original units

Response (anonymized):

```json
{
	"feedback": {
		"id": "WP-000001",
		"content": "Updated content",
		"createdAt": "2026-05-05T08:10:00.000Z",
		"updatedAt": "2026-05-05T08:30:00.000Z"
	}
}
```

### Admin: login

`POST /api/admin/login`

Request:

```json
{ "password": "your-admin-password" }
```

Response:

```json
{ "token": "jwt-token" }
```

Use token in header:

```bash
Authorization: Bearer <token>
```

### Admin: export anonymized

`GET /api/admin/export/anonymized`

Requires admin token.

### Admin: export full internal

`GET /api/admin/export/full`

Requires admin token.

## Notes

- Public APIs never return `name` or `units`
- Ownership validation is enforced in backend
- Recommended: keep Supabase Service Role Key only on server side
- Admin login is rate-limited to reduce brute-force attempts
- Admin JWT uses issuer + audience + role validation
