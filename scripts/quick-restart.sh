#!/bin/bash

# Codex API Pool 快速重启脚本
# 用法: ./scripts/quick-restart.sh

set -e  # 遇到错误立即退出

echo "🔍 检查现有进程..."
OLD_PID=$(ps aux | grep "node.*server.mjs" | grep -v grep | awk '{print $2}')

if [ -n "$OLD_PID" ]; then
  echo "⏹️  停止旧进程 (PID: $OLD_PID)..."
  kill $OLD_PID
  sleep 2

  # 如果进程还在，强制 kill
  if ps -p $OLD_PID > /dev/null 2>&1; then
    echo "⚠️  进程未响应，强制停止..."
    kill -9 $OLD_PID
    sleep 1
  fi
  echo "✅ 旧进程已停止"
else
  echo "ℹ️  没有找到运行中的进程"
fi

echo ""
echo "🔄 重启 LaunchAgent 服务..."

# 停止 LaunchAgent（如果正在运行）
npm run service:stop 2>/dev/null || true

# 重新启动
npm run service:restart

echo ""
echo "✅ 重启完成！"
echo ""
echo "📊 服务状态："
npm run service:status
