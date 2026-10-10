-- Active ownership is exclusive per GitHub repository, independent of installation or branch.
-- Disabled history remains untouched. Existing duplicates must be resolved explicitly;
-- CREATE UNIQUE INDEX will fail instead of silently unbinding anyone.
CREATE UNIQUE INDEX "repositories_one_enabled_per_github_repository"
ON "repositories"("github_repository_id") WHERE "enabled";
