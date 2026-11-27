# Google Play 스토어 등록정보 (Pangmote for Android)

기본 언어는 한국어(ko-KR), 번역으로 영어(en-US)를 추가합니다. 그림은 `art/`에 있습니다(`node android/play/art.js`로 다시 그림).
글자 수 한도: 앱 이름 30자, 간단한 설명 80자, 자세한 설명 4000자.

## 한국어 (ko-KR)

**앱 이름**

```
Pangmote - 원격 데스크톱
```

**간단한 설명**

```
휴대폰으로 내 PC를 그 앞에 앉은 것처럼. 무료, P2P 직접 연결, 종단간 암호화.
```

**자세한 설명**

```
Pangmote는 다른 곳에 있는 내 PC를 휴대폰으로 조종하는 무료 원격 데스크톱입니다. PC에는 무료 Pangmote 호스트(Windows 10·11, Linux X11 세션)를 설치해 켜 둡니다.

■ 그 앞에 앉은 것처럼
• 트랙패드 방식: 화면 전체가 노트북 터치패드가 됩니다. 손가락을 끄는 만큼 커서가 움직여서 작은 버튼도 정확하게 누릅니다.
• 탭은 클릭, 길게 누르고 떼면 오른쪽 클릭, 길게 누른 채 끌면 드래그, 두 손가락으로 스크롤과 확대입니다.
• PC의 입력칸을 누르면 휴대폰 키보드가 저절로 올라오고, 입력하는 줄이 키보드 위에 보입니다. 한글도 그대로 입력됩니다.
• 모니터가 여러 대면 두 손가락으로 옆으로 밀어 옆 모니터로 넘어갑니다.
• 손가락이 닿은 곳을 누르는 직접 터치 방식도 있습니다.

■ QR 한 번으로 연결
• PC의 호스트 창에서 "휴대폰 추가" QR을 찍으면 그 PC가 목록에 들어가고, 다음부터는 누르기만 하면 접속합니다.
• QR에는 접속 키가 들어 있지 않고, 한 번 쓰이면 바로 바뀝니다.

■ 안전하게
• 화면과 입력은 휴대폰과 PC 사이를 직접(P2P), 종단간 암호화되어 오갑니다.
• 연결을 맺는 메시지는 공개 중계 서버를 거치지만 암호화되어 있어 중계 서버도 읽을 수 없습니다.
• 회원 가입, 광고, 사용 기록 수집이 없습니다.
• 휴대폰을 잃어버리면 PC의 호스트 창에서 그 휴대폰만 차단할 수 있습니다.

■ 알아 두세요
• PC에 Pangmote 호스트가 켜져 있어야 합니다. 내려받기: https://github.com/GiUKim/pangmote
• PC는 켜져 있고 절전 모드가 꺼져 있어야 합니다.
• 회사 PC는 회사의 보안 정책이 허용할 때만 쓰세요.
• 개인이 만든 오픈소스(MIT) 프로그램이며 보안 감사를 받지 않았습니다.
```

**출시 노트** (비공개 테스트 첫 버전)

```
첫 시험 버전입니다. QR로 PC 추가, 트랙패드 방식, 입력칸을 누르면 올라오는 키보드, 두 손가락으로 옆 모니터. PC의 Pangmote 호스트는 0.12.1 이상이어야 합니다.
```

## English (en-US)

**App name**

```
Pangmote - Remote Desktop
```

**Short description**

```
Use your own PC from your phone as if you sat at it. Free, direct, encrypted.
```

**Full description**

```
Pangmote is a free remote desktop: your phone controls your own PC somewhere else. The PC runs the free Pangmote host (Windows 10 or 11, or Linux with an X11 session).

■ As if you sat at it
• Trackpad mode: the whole screen is a laptop's touchpad. The pointer moves as far as your finger, so even small buttons are easy to hit.
• Tap to click, long press and release for a right-click, long press and move to drag, two fingers to scroll and zoom.
• Tap a text field on the PC and the phone's keyboard comes up by itself, with the line you type kept above it.
• Several monitors: move two fingers sideways to go to the monitor beside.
• Direct touch mode is there too: a touch presses where your finger is.

■ Connected with one QR code
• Scan the "Add a phone" QR code in the PC's host window and the PC stays on your list: from then on, one tap connects.
• The QR code holds no access key and changes as soon as it is used.

■ Safe
• The screen and your input go directly between the phone and the PC (peer to peer), end-to-end encrypted.
• The messages that set up a connection pass a public relay, encrypted so that the relay cannot read them either.
• No account, no ads, no usage data collected.
• Lost your phone? Block just that phone in the PC's host window.

■ Good to know
• The PC needs the Pangmote host running. Download: https://github.com/GiUKim/pangmote
• The PC must be on, with sleep turned off.
• Use it with a work PC only where your company's security policy allows it.
• Open source (MIT), made by one person, not security audited.
```

**Release notes** (first closed test)

```
First test version: add a PC with a QR code, trackpad mode, the keyboard that comes up on a text field, two fingers to the monitor beside. The PC's Pangmote host must be 0.12.1 or later.
```

## 그림

| 항목 | 파일 | 규격 |
|---|---|---|
| 앱 아이콘 | `art/icon-512.png` | 512x512 PNG (Play가 모서리를 둥글게 깎음) |
| 그래픽 이미지 (feature graphic) | `art/feature-ko.jpg`, `art/feature-en.jpg` | 1024x500, 투명 없음 |
| 휴대전화 스크린샷 | `art/list-ko.jpg`, `art/list-en.jpg` + 휴대폰에서 찍은 것 (README의 "스크린샷") | 2~8장, 1920x1080 |
