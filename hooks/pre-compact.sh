#!/bin/sh
# cc-channel-mem PreCompact Hook
# 컨텍스트 압축 직전 curator.js 를 실행해 오늘 로그를 MEMORY.md 에 반영한다.
# Claude Code settings.json 에 등록:
#   "hooks": {
#     "PreCompact": [{"matcher":"","hooks":[{"type":"command","command":"~/.cc-channel-mem/hooks/pre-compact.sh"}]}]
#   }

PACKAGE_DIR="$(dirname "$(dirname "$(realpath "$0")")")"

node -e "
require('dotenv').config({ path: require('path').join(require('os').homedir(), '.cc-channel-mem', '.env') });
const {curate} = require('$PACKAGE_DIR/src/memory/curator');
curate().then(() => process.exit(0)).catch(() => process.exit(0));
" 2>/dev/null || true
