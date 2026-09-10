ALTER TABLE "users" ADD COLUMN "repository_version" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "github_installations" (
  "id" VARCHAR(32) NOT NULL,
  "account_id" VARCHAR(32) NOT NULL,
  "account_login" VARCHAR(100) NOT NULL,
  "verified_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repositories" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "installation_id" VARCHAR(32) NOT NULL,
  "github_repository_id" VARCHAR(32) NOT NULL,
  "full_name" VARCHAR(220) NOT NULL,
  "default_branch" VARCHAR(255) NOT NULL,
  "branch" VARCHAR(255) NOT NULL,
  "is_private" BOOLEAN NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "bound_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unbound_at" TIMESTAMPTZ(3),
  CONSTRAINT "repositories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "repositories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "repositories_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "repositories_one_enabled_per_user" ON "repositories"("user_id") WHERE enabled;
CREATE INDEX "repositories_installation_id_github_repository_id_enabled_idx" ON "repositories"("installation_id", "github_repository_id", "enabled");
