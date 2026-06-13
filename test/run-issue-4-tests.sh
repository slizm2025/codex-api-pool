#!/bin/bash
# Test runner for Messages → Chat Completions conversion

set -e

echo "========================================="
echo "Testing Messages → Chat Conversion"
echo "========================================="
echo ""

echo "Step 1: Static verification..."
node test/static-verify-messages-to-chat.mjs
echo ""

echo "Step 2: Runtime conversion tests..."
node test/messages-to-chat-conversion.test.mjs
echo ""

echo "========================================="
echo "✅ All Issue #4 tests passed!"
echo "========================================="
