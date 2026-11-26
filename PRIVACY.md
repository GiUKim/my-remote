# Privacy policy

Pangmote (called My Remote up to version 0.9.x) collects no usage data, analytics, crash reports or anything else about you, and this project runs
no server of its own. The program connects to other systems only for what it does:

| What | To where | When | What they see |
|---|---|---|---|
| The handshake between your PCs, and the client page the host hands to a client (encrypted with keys derived from the access key) | the relay: the public ntfy server [ntfy.sh](https://ntfy.sh), or the server set in the host's `config.json` | while the host runs (it listens), and when a client connects | the PCs' IP addresses, the times, and messages it cannot read; never the access key, the screen or what you type |
| Finding a direct path between your PCs | the STUN servers `stun.l.google.com` (Google) and `stun.cloudflare.com` (Cloudflare), or those set in `config.json` | when a connection is set up | the PCs' IP addresses |
| The screen, sound, input, clipboard, files, and the client's connection measurements | directly between your PCs (WebRTC, encrypted end to end) | during a connection | nobody but your PCs (a TURN server you add yourself would relay the encrypted stream) |
| Updates of the installed app | this repository's releases on GitHub (`github.com`) | 20 seconds after the app starts and every 6 hours | GitHub sees the PC's IP address and that it asked for the latest version |

- **Updates:** an ordinary update is only announced and is installed when you say so; one marked critical
  installs itself; a new base of the app (a new Electron) is downloaded and put in place by itself while no
  session is on. Whatever is downloaded is checked against the project's signature before it runs.
- **When the relay refuses the host's messages** (HTTP 429, which ntfy.sh answers once an internet address has
  sent its messages of the day): the host asks the same relay how many messages remain and when the limit resets
  (`/v1/account`, without an account), to say so in the host window. It asks when the refusals begin and at most
  every 10 minutes while they last; the question carries nothing, and the relay sees the PC's IP address as it
  does anyway.
- **Stays on your PC:** the access key (encrypted by the system), the list of PCs, the access log of the host,
  the diagnostics log (`diag.log`: figures about the connection) and the settings. None of it is sent anywhere.
- **Links** in the program (sponsoring, reporting a problem, the business inquiry) open your browser only when
  you click them.
- **No spell checker:** the program turns off the engine's spell checker, which would otherwise fetch a
  dictionary from Google's servers.
- A client opened as `pangmote-client.html` in a browser is also subject to that browser's own behaviour.

This policy covers the program as published here. Questions: [open an issue](https://github.com/GiUKim/pangmote/issues).

---

## 개인정보 처리 방침

Pangmote(0.9.x까지의 이름은 My Remote)는 사용 기록, 분석 정보, 오류 보고 등 사용자에 대한 어떤 정보도 모으지 않으며, 이 프로젝트가 운영하는
서버도 없습니다. 프로그램은 하는 일에 필요한 곳에만 접속합니다.

| 무엇 | 어디로 | 언제 | 그쪽에서 보이는 것 |
|---|---|---|---|
| 두 PC 사이의 연결 절차, 호스트가 클라이언트에 주는 화면 페이지 (접속 키에서 만든 키로 암호화) | 중계 서버: 공개 ntfy 서버 [ntfy.sh](https://ntfy.sh) 또는 호스트 `config.json`에 정한 서버 | 호스트가 켜져 있는 동안(기다림), 클라이언트가 접속할 때 | PC의 IP 주소, 시각, 읽을 수 없는 메시지. 접속 키, 화면, 입력 내용은 보이지 않습니다 |
| 두 PC가 직접 연결할 길 찾기 | STUN 서버 `stun.l.google.com`(Google), `stun.cloudflare.com`(Cloudflare) 또는 `config.json`에 정한 서버 | 연결을 맺을 때 | PC의 IP 주소 |
| 화면, 소리, 입력, 클립보드, 파일, 클라이언트의 연결 측정값 | 두 PC 사이에 직접 (WebRTC, 종단간 암호화) | 연결 중 | 두 PC 외에는 아무도 볼 수 없습니다 (직접 추가한 TURN 서버는 암호화된 흐름을 전달만 합니다) |
| 설치된 앱의 업데이트 확인 | 이 저장소의 GitHub 릴리스 (`github.com`) | 앱 시작 20초 뒤와 6시간마다 | GitHub에 PC의 IP 주소와 최신 버전을 물었다는 사실 |

- **업데이트:** 일반 업데이트는 알리기만 하고 사용자가 고를 때 설치합니다. 중요 업데이트는 스스로 설치됩니다. 앱
  바탕(새 Electron)은 연결이 없을 때 스스로 내려받아 바꿉니다. 내려받은 것은 실행 전에 프로젝트의 서명을 확인합니다.
- **중계 서버가 호스트의 메시지를 거부할 때**(HTTP 429. ntfy.sh는 인터넷 주소 하나가 하루 한도를 다 쓰면 이렇게 답합니다):
  호스트 창에 알리려고 같은 중계 서버에 남은 메시지 수와 한도가 풀리는 시각을 묻습니다(`/v1/account`, 계정 없이). 거부가
  시작될 때, 그리고 거부가 이어지는 동안 10분에 한 번까지 묻습니다. 질문에 담아 보내는 것은 없고, 중계 서버에는 원래처럼
  PC의 IP 주소만 보입니다.
- **이 PC에만 남는 것:** 접속 키(시스템이 암호화), PC 목록, 호스트의 접속 기록, 진단 기록(`diag.log`: 연결에 대한
  숫자), 설정. 어디로도 보내지 않습니다.
- **프로그램 안의 링크**(후원, 문제 신고, 업무용 문의)는 누를 때만 브라우저로 열립니다.
- **맞춤법 검사 없음:** 엔진의 맞춤법 검사를 꺼서, Google 서버에서 사전을 내려받지 않습니다.
- 브라우저로 연 `pangmote-client.html`에는 그 브라우저 자체의 동작도 적용됩니다.

문의: [이슈 열기](https://github.com/GiUKim/pangmote/issues)
