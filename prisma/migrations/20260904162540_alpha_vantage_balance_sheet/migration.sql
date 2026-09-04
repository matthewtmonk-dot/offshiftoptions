-- AlterTable
ALTER TABLE "TickerFundamentals" ADD COLUMN     "balanceSheetCurrentRatio" DECIMAL(12,4),
ADD COLUMN     "balanceSheetDebtToEquity" DECIMAL(12,4),
ADD COLUMN     "balanceSheetFetchedAt" TIMESTAMP(3),
ADD COLUMN     "balanceSheetFiscalDateEnding" TIMESTAMP(3),
ADD COLUMN     "balanceSheetLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "balanceSheetLastAttemptStatus" TEXT,
ADD COLUMN     "balanceSheetLastErrorMessage" TEXT,
ADD COLUMN     "balanceSheetStaleAfter" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "TickerFundamentals_balanceSheetStaleAfter_idx" ON "TickerFundamentals"("balanceSheetStaleAfter");
