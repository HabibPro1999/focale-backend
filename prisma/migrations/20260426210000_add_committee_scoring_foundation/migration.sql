-- CreateTable
CREATE TABLE "abstract_committee_memberships" (
    "id" STRING NOT NULL,
    "user_id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_committee_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstract_reviews" (
    "id" STRING NOT NULL,
    "abstract_id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "reviewer_id" STRING NOT NULL,
    "score" FLOAT8,
    "comment" STRING,
    "scored_at" TIMESTAMP(3),
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abstract_reviewer_themes" (
    "id" STRING NOT NULL,
    "user_id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "theme_id" STRING NOT NULL,
    "active" BOOL NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abstract_reviewer_themes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "abstract_committee_memberships_user_id_event_id_key" ON "abstract_committee_memberships"("user_id", "event_id");

-- CreateIndex
CREATE INDEX "abstract_committee_memberships_event_id_active_idx" ON "abstract_committee_memberships"("event_id", "active");

-- CreateIndex
CREATE INDEX "abstract_committee_memberships_user_id_active_idx" ON "abstract_committee_memberships"("user_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_reviews_abstract_id_reviewer_id_key" ON "abstract_reviews"("abstract_id", "reviewer_id");

-- CreateIndex
CREATE INDEX "abstract_reviews_reviewer_id_event_id_active_scored_at_idx" ON "abstract_reviews"("reviewer_id", "event_id", "active", "scored_at");

-- CreateIndex
CREATE INDEX "abstract_reviews_event_id_active_scored_at_idx" ON "abstract_reviews"("event_id", "active", "scored_at");

-- CreateIndex
CREATE INDEX "abstract_reviews_abstract_id_active_idx" ON "abstract_reviews"("abstract_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "abstract_reviewer_themes_user_id_event_id_theme_id_key" ON "abstract_reviewer_themes"("user_id", "event_id", "theme_id");

-- CreateIndex
CREATE INDEX "abstract_reviewer_themes_event_id_theme_id_idx" ON "abstract_reviewer_themes"("event_id", "theme_id");

-- CreateIndex
CREATE INDEX "abstract_reviewer_themes_user_id_event_id_active_idx" ON "abstract_reviewer_themes"("user_id", "event_id", "active");

-- AddForeignKey
ALTER TABLE "abstract_committee_memberships" ADD CONSTRAINT "abstract_committee_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_committee_memberships" ADD CONSTRAINT "abstract_committee_memberships_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviews" ADD CONSTRAINT "abstract_reviews_abstract_id_fkey" FOREIGN KEY ("abstract_id") REFERENCES "abstracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviews" ADD CONSTRAINT "abstract_reviews_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviews" ADD CONSTRAINT "abstract_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviewer_themes" ADD CONSTRAINT "abstract_reviewer_themes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviewer_themes" ADD CONSTRAINT "abstract_reviewer_themes_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abstract_reviewer_themes" ADD CONSTRAINT "abstract_reviewer_themes_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "abstract_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
