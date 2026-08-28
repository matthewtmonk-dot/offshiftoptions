-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PRIVATE', 'SHARED');

-- CreateEnum
CREATE TYPE "TradeStrategy" AS ENUM ('CASH_SECURED_PUT');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('OPEN', 'CLOSED', 'EXPIRED', 'ASSIGNED', 'ROLLED');

-- CreateEnum
CREATE TYPE "TradeLegAction" AS ENUM ('SELL_TO_OPEN', 'BUY_TO_CLOSE', 'EXPIRE', 'ASSIGN', 'ROLL_OPEN', 'ROLL_CLOSE');

-- CreateEnum
CREATE TYPE "WatchlistItemStatus" AS ENUM ('WATCHING', 'RESEARCHING', 'READY', 'DO_NOT_TRADE');

-- CreateEnum
CREATE TYPE "NoteCategory" AS ENUM ('PRO', 'CON', 'GENERAL');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('NEW', 'WATCHING', 'DISMISSED', 'DONE');

-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('PRIVATE', 'GROUP');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('RECOMMENDATION', 'COMMENT', 'REACTION', 'MESSAGE', 'TRADE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('WATCHLIST', 'RECOMMENDATION', 'COMMENT', 'REACTION', 'TRADE', 'SCANNER', 'LEARNING');

-- CreateEnum
CREATE TYPE "ReactionKind" AS ENUM ('ATTA_BOY', 'CHECKING', 'NICE_MANAGEMENT');

-- CreateEnum
CREATE TYPE "ReactionTargetType" AS ENUM ('WATCHLIST_ITEM', 'RECOMMENDATION', 'COMMENT', 'TRADE', 'ACTIVITY');

-- CreateEnum
CREATE TYPE "ScannerOperator" AS ENUM ('LTE', 'GTE', 'BETWEEN', 'EQ', 'NEQ', 'EXISTS');

-- CreateEnum
CREATE TYPE "CriterionStatus" AS ENUM ('PASS', 'FAIL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OptionType" AS ENUM ('PUT', 'CALL');

-- CreateEnum
CREATE TYPE "BrokerProvider" AS ENUM ('MOCK', 'SCHWAB');

-- CreateEnum
CREATE TYPE "BrokerConnectionStatus" AS ENUM ('MOCK', 'DISCONNECTED', 'CONNECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "darkMode" BOOLEAN NOT NULL DEFAULT true,
    "compactMode" BOOLEAN NOT NULL DEFAULT false,
    "enableInAppNotify" BOOLEAN NOT NULL DEFAULT true,
    "enableWebPushNotify" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharingPreferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "defaultTrade" "Visibility" NOT NULL DEFAULT 'SHARED',
    "defaultPosition" "Visibility" NOT NULL DEFAULT 'SHARED',
    "defaultWatchlist" "Visibility" NOT NULL DEFAULT 'SHARED',
    "defaultNote" "Visibility" NOT NULL DEFAULT 'SHARED',
    "defaultRecommendation" "Visibility" NOT NULL DEFAULT 'SHARED',
    "defaultAccountBalance" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "defaultDollarPL" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "defaultPercentPL" "Visibility" NOT NULL DEFAULT 'SHARED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharingPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brokerName" TEXT NOT NULL DEFAULT 'Manual',
    "accountType" TEXT NOT NULL DEFAULT 'Demo',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountValue" DECIMAL(14,2) NOT NULL,
    "cash" DECIMAL(14,2) NOT NULL,
    "cashSecuringPuts" DECIMAL(14,2) NOT NULL,
    "availableCash" DECIMAL(14,2) NOT NULL,
    "realizedPL" DECIMAL(14,2) NOT NULL,
    "unrealizedPL" DECIMAL(14,2) NOT NULL,
    "premiumCollected" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "AccountSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "strategy" "TradeStrategy" NOT NULL DEFAULT 'CASH_SECURED_PUT',
    "symbol" TEXT NOT NULL,
    "contracts" INTEGER NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'OPEN',
    "visibility" "Visibility" NOT NULL DEFAULT 'SHARED',
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "notes" TEXT,
    "rolledFromTradeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeLeg" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "action" "TradeLegAction" NOT NULL,
    "symbol" TEXT NOT NULL,
    "contracts" INTEGER NOT NULL,
    "strike" DECIMAL(12,2) NOT NULL,
    "expiration" TIMESTAMP(3) NOT NULL,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "premium" DECIMAL(12,4),
    "price" DECIMAL(12,4),
    "fees" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "delta" DECIMAL(10,4),
    "gamma" DECIMAL(10,4),
    "theta" DECIMAL(10,4),
    "vega" DECIMAL(10,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionSnapshot" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stockPrice" DECIMAL(12,2) NOT NULL,
    "optionBid" DECIMAL(12,4) NOT NULL,
    "optionAsk" DECIMAL(12,4) NOT NULL,
    "optionMark" DECIMAL(12,4) NOT NULL,
    "delta" DECIMAL(10,4),
    "gamma" DECIMAL(10,4),
    "theta" DECIMAL(10,4),
    "vega" DECIMAL(10,4),
    "impliedVolatility" DECIMAL(10,4),
    "openInterest" INTEGER,
    "optionVolume" INTEGER,

    CONSTRAINT "PositionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL DEFAULT 'SHARED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "watchlistId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "status" "WatchlistItemStatus" NOT NULL DEFAULT 'WATCHING',
    "visibility" "Visibility" NOT NULL DEFAULT 'SHARED',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockNote" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "watchlistItemId" TEXT,
    "category" "NoteCategory" NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL DEFAULT 'SHARED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "ticker" TEXT,
    "body" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL DEFAULT 'SHARED',
    "recommendationId" TEXT,
    "tradeId" TEXT,
    "watchlistItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "reasonTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibility" "Visibility" NOT NULL DEFAULT 'SHARED',
    "status" "RecommendationStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL DEFAULT 'PRIVATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMember" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3),

    CONSTRAINT "ConversationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ticker" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessageRead" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessageRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reaction" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" "ReactionKind" NOT NULL,
    "targetType" "ReactionTargetType" NOT NULL,
    "tradeId" TEXT,
    "recommendationId" TEXT,
    "watchlistItemId" TEXT,
    "commentId" TEXT,
    "activityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "ticker" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'SHARED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScannerProfile" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScannerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScannerRule" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "operator" "ScannerOperator" NOT NULL,
    "valueJson" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ScannerRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'DEMO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "summaryStatus" "CriterionStatus" NOT NULL,
    "passedCriteria" INTEGER NOT NULL,
    "totalCriteria" INTEGER NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanCriterionResult" (
    "id" TEXT NOT NULL,
    "scanResultId" TEXT NOT NULL,
    "criterionName" TEXT NOT NULL,
    "actualValue" TEXT,
    "operator" TEXT NOT NULL,
    "desiredValue" TEXT NOT NULL,
    "status" "CriterionStatus" NOT NULL,
    "explanation" TEXT NOT NULL,

    CONSTRAINT "ScanCriterionResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketQuoteCache" (
    "symbol" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "change" DECIMAL(12,2),
    "changePercent" DECIMAL(10,4),
    "asOf" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MOCK',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketQuoteCache_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "PriceCandle" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(12,2) NOT NULL,
    "high" DECIMAL(12,2) NOT NULL,
    "low" DECIMAL(12,2) NOT NULL,
    "close" DECIMAL(12,2) NOT NULL,
    "adjClose" DECIMAL(12,2),
    "volume" BIGINT NOT NULL,

    CONSTRAINT "PriceCandle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionContractSnapshot" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "underlyingSymbol" TEXT NOT NULL,
    "optionType" "OptionType" NOT NULL,
    "strike" DECIMAL(12,2) NOT NULL,
    "expiration" TIMESTAMP(3) NOT NULL,
    "bid" DECIMAL(12,4) NOT NULL,
    "ask" DECIMAL(12,4) NOT NULL,
    "mark" DECIMAL(12,4) NOT NULL,
    "last" DECIMAL(12,4),
    "delta" DECIMAL(10,4),
    "gamma" DECIMAL(10,4),
    "theta" DECIMAL(10,4),
    "vega" DECIMAL(10,4),
    "impliedVolatility" DECIMAL(10,4),
    "openInterest" INTEGER,
    "volume" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OptionContractSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "BrokerProvider" NOT NULL,
    "label" TEXT NOT NULL,
    "status" "BrokerConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SharingPreferences_userId_key" ON "SharingPreferences"("userId");

-- CreateIndex
CREATE INDEX "TradingAccount_userId_visibility_idx" ON "TradingAccount"("userId", "visibility");

-- CreateIndex
CREATE INDEX "AccountSnapshot_accountId_capturedAt_idx" ON "AccountSnapshot"("accountId", "capturedAt");

-- CreateIndex
CREATE INDEX "Trade_userId_visibility_idx" ON "Trade"("userId", "visibility");

-- CreateIndex
CREATE INDEX "Trade_symbol_idx" ON "Trade"("symbol");

-- CreateIndex
CREATE INDEX "Trade_status_idx" ON "Trade"("status");

-- CreateIndex
CREATE INDEX "TradeLeg_tradeId_idx" ON "TradeLeg"("tradeId");

-- CreateIndex
CREATE INDEX "TradeLeg_symbol_expiration_strike_idx" ON "TradeLeg"("symbol", "expiration", "strike");

-- CreateIndex
CREATE INDEX "PositionSnapshot_tradeId_capturedAt_idx" ON "PositionSnapshot"("tradeId", "capturedAt");

-- CreateIndex
CREATE INDEX "Watchlist_ownerId_visibility_idx" ON "Watchlist"("ownerId", "visibility");

-- CreateIndex
CREATE INDEX "WatchlistItem_ownerId_visibility_idx" ON "WatchlistItem"("ownerId", "visibility");

-- CreateIndex
CREATE INDEX "WatchlistItem_ticker_idx" ON "WatchlistItem"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_watchlistId_ticker_key" ON "WatchlistItem"("watchlistId", "ticker");

-- CreateIndex
CREATE INDEX "StockNote_ownerId_visibility_idx" ON "StockNote"("ownerId", "visibility");

-- CreateIndex
CREATE INDEX "StockNote_ticker_idx" ON "StockNote"("ticker");

-- CreateIndex
CREATE INDEX "Comment_authorId_visibility_idx" ON "Comment"("authorId", "visibility");

-- CreateIndex
CREATE INDEX "Comment_ticker_idx" ON "Comment"("ticker");

-- CreateIndex
CREATE INDEX "Recommendation_senderId_idx" ON "Recommendation"("senderId");

-- CreateIndex
CREATE INDEX "Recommendation_recipientId_status_idx" ON "Recommendation"("recipientId", "status");

-- CreateIndex
CREATE INDEX "Recommendation_ticker_idx" ON "Recommendation"("ticker");

-- CreateIndex
CREATE INDEX "ConversationMember_userId_idx" ON "ConversationMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationMember_conversationId_userId_key" ON "ConversationMember"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_senderId_idx" ON "ChatMessage"("senderId");

-- CreateIndex
CREATE INDEX "ChatMessage_ticker_idx" ON "ChatMessage"("ticker");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessageRead_messageId_userId_key" ON "ChatMessageRead"("messageId", "userId");

-- CreateIndex
CREATE INDEX "Reaction_actorId_idx" ON "Reaction"("actorId");

-- CreateIndex
CREATE INDEX "Reaction_targetType_idx" ON "Reaction"("targetType");

-- CreateIndex
CREATE INDEX "Activity_actorId_visibility_idx" ON "Activity"("actorId", "visibility");

-- CreateIndex
CREATE INDEX "Activity_ticker_idx" ON "Activity"("ticker");

-- CreateIndex
CREATE INDEX "Notification_recipientId_readAt_idx" ON "Notification"("recipientId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_enabled_idx" ON "PushSubscription"("userId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ScannerProfile_ownerId_name_key" ON "ScannerProfile"("ownerId", "name");

-- CreateIndex
CREATE INDEX "ScannerRule_profileId_enabled_idx" ON "ScannerRule"("profileId", "enabled");

-- CreateIndex
CREATE INDEX "ScanRun_ownerId_createdAt_idx" ON "ScanRun"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "ScanResult_runId_idx" ON "ScanResult"("runId");

-- CreateIndex
CREATE INDEX "ScanResult_ticker_idx" ON "ScanResult"("ticker");

-- CreateIndex
CREATE INDEX "ScanCriterionResult_scanResultId_status_idx" ON "ScanCriterionResult"("scanResultId", "status");

-- CreateIndex
CREATE INDEX "PriceCandle_symbol_idx" ON "PriceCandle"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "PriceCandle_symbol_date_key" ON "PriceCandle"("symbol", "date");

-- CreateIndex
CREATE INDEX "OptionContractSnapshot_underlyingSymbol_expiration_strike_idx" ON "OptionContractSnapshot"("underlyingSymbol", "expiration", "strike");

-- CreateIndex
CREATE INDEX "OptionContractSnapshot_symbol_capturedAt_idx" ON "OptionContractSnapshot"("symbol", "capturedAt");

-- CreateIndex
CREATE INDEX "BrokerConnection_userId_provider_idx" ON "BrokerConnection"("userId", "provider");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharingPreferences" ADD CONSTRAINT "SharingPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSnapshot" ADD CONSTRAINT "AccountSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_rolledFromTradeId_fkey" FOREIGN KEY ("rolledFromTradeId") REFERENCES "Trade"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeLeg" ADD CONSTRAINT "TradeLeg_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionSnapshot" ADD CONSTRAINT "PositionSnapshot_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watchlist" ADD CONSTRAINT "Watchlist_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_watchlistId_fkey" FOREIGN KEY ("watchlistId") REFERENCES "Watchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockNote" ADD CONSTRAINT "StockNote_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockNote" ADD CONSTRAINT "StockNote_watchlistItemId_fkey" FOREIGN KEY ("watchlistItemId") REFERENCES "WatchlistItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_watchlistItemId_fkey" FOREIGN KEY ("watchlistItemId") REFERENCES "WatchlistItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageRead" ADD CONSTRAINT "ChatMessageRead_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageRead" ADD CONSTRAINT "ChatMessageRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_watchlistItemId_fkey" FOREIGN KEY ("watchlistItemId") REFERENCES "WatchlistItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScannerProfile" ADD CONSTRAINT "ScannerProfile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScannerRule" ADD CONSTRAINT "ScannerRule_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ScannerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanRun" ADD CONSTRAINT "ScanRun_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ScannerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanRun" ADD CONSTRAINT "ScanRun_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanResult" ADD CONSTRAINT "ScanResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ScanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanCriterionResult" ADD CONSTRAINT "ScanCriterionResult_scanResultId_fkey" FOREIGN KEY ("scanResultId") REFERENCES "ScanResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerConnection" ADD CONSTRAINT "BrokerConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
