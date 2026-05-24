CREATE TABLE "abstract_code_sequences" (
  "id" STRING NOT NULL,
  "final_type" "AbstractFinalType" NOT NULL,
  "last_value" INT4 NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "abstract_code_sequences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "abstract_code_sequences_final_type_key"
  ON "abstract_code_sequences"("final_type");
