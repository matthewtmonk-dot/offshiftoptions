import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { runProductionBootstrap } from "../src/lib/bootstrap";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run the production bootstrap.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

async function main() {
  const summary = await runProductionBootstrap(prisma);

  for (const user of summary.users) {
    console.log(`${user.email}: ${user.created ? "created" : "already existed (left unchanged)"}`);
  }
  console.log(
    `Matt/Eric conversation: ${summary.conversationCreated ? "created" : "already existed (left unchanged)"}`,
  );
  console.log("Production bootstrap complete. No existing users or data were deleted or modified.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
