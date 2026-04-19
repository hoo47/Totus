# Totus AI Agent Platform

모듈형 AI 코딩 에이전트 플랫폼입니다. 여러 LLM 프로바이더 연동과 이벤트 기반 대화 기록(Event Sourcing), 에이전트별 도구 제어를 지원합니다.

## 시스템 요구사항
- Node.js >= 20.0.0
- pnpm >= 9.15.0

## 프로젝트 구조 (Monorepo)
- `packages/core`: 에이전트 Orchestrator, LLM Provider, Event Store, Query Loop 로직
- `packages/tools`: 에이전트가 사용할 도구 묶음 (Shell, File System 등)
- `packages/cli`: 터미널에서 에이전트를 실행할 수 있는 실행형 인터페이스 (REPL)
- `packages/plugin-coding`: 코딩 중심의 전문 에이전트 플러그인 정의
- `packages/server`: 웹/API 서버 (향후 개발)
- `packages/web`: 웹 프론트엔드 UI (향후 개발)

## 설치 및 빌드 방법

1. 전역 의존성 설치 (pnpm이 없는 경우):
   ```bash
   npm install -g pnpm
   ```

2. 프로젝트 패키지 설치:
   ```bash
   pnpm install
   ```

3. 전체 패키지 빌드:
   ```bash
   pnpm run build
   ```

## CLI 사용법 (CLI Interface)

CLI 모듈을 통해 터미널 환경에서 코딩 에이전트를 구동할 수 있습니다. 

### 환경변수 설정
프로젝트 최상단 혹은 `packages/cli` 디렉토리에 `.env` 파일을 생성하고 아래와 같은 형태로 사용할 프로바이더의 API 키를 설정하세요.
```env
OPENAI_API_KEY="sk-..."
ANTHROPIC_API_KEY="sk-ant-..."
GEMINI_API_KEY="AIza..."
```
*(로컬 Ollama를 사용하는 경우 로컬 호스트를 자동으로 바라보며, 키가 필요하지 않습니다.)*

### 실행 명령어

빌드가 완료된 후, 아래의 명령어로 CLI REPL(대화형 상호작용 루프) 환경에 진입할 수 있습니다.

```bash
# 방법 1: pnpm workspace를 통한 실행
pnpm exec totus

# 방법 2: node로 직접 실행
node packages/cli/bin/totus.js
```

### 흐름 및 주요 기능
1. **시작 및 초기화**: 에이전트 설정(코딩 관련 도구 주입) 및 로컬 환경 내 SQLite 기반 Event Store가 로드됩니다.
2. **다중 모델 연동**: `openAPI`, `claude`, `ollama` 등 모델 어댑터를 통해 원활한 AI 추론이 진행됩니다.
3. **도구 실행 권한 체계**: 파일 쓰기, 명령어 실행 등 보안에 위협이 되는 도구 사용 시 사용자에게 [Y/n] 권한을 요청합니다.
4. **대화 압축 & 기록**: REPL 종료 후에도 생성된 `memory/` 폴더 내 SQLite DB에 기록이 남아 추후 포크(Fork) 및 복구(Resume)가 가능합니다.
