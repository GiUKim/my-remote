# Google Play에 올리기 (Pangmote for Android)

2026-11-27에 준비했습니다. 개인 개발자 계정은 **테스터 12명이 14일 연속 참여한 비공개 테스트**를 거쳐야 정식 출시(프로덕션)를
신청할 수 있어서, 계정을 만든 날부터 빨라야 3~4주 걸립니다.

| 단계 | 누가 | 걸리는 시간 |
|---|---|---|
| 1. 개발자 계정 | 사용자 | 1~3일 (본인 확인) |
| 2. 업로드 키 만들기 | 사용자 (이 PC에서 한 번) | 몇 분 |
| 3. 번들 받기, 서명 | 받기는 에이전트, 서명은 사용자 | 몇 분 |
| 4. Play Console에서 앱 만들기, 양식 채우기 | 사용자 (값은 아래와 `listing.md`) | 한두 시간 |
| 5. 비공개 테스트 출시 → 검토 | 사용자 | 며칠 |
| 6. 테스터 12명 이상, 14일 연속 | 사용자 (모집) | 14일 |
| 7. 앱 서명 인증서를 assetlinks.json에 | 에이전트 (지문만 알려 주시면) | 몇 분 |
| 8. 프로덕션 신청 → 검토 → 출시 | 사용자 | 보통 1주 안팎 |

업로드 키와 그 비밀번호는 사용자만 다룹니다. 에이전트는 키 파일을 읽거나 옮기지 않고, 비밀번호를 묻지 않습니다.

## 1. 개발자 계정

<https://play.google.com/console/signup> 에서 **개인(Personal)** 계정을 만듭니다: 등록비 25달러, 신분증으로 본인 확인,
안드로이드 휴대폰으로 기기 확인(Play Console 앱), 연락처. 스토어에는 개발자 이름과 연락 이메일이 공개됩니다(이 앱용 이메일을
따로 만들어 쓰는 것도 방법입니다).

## 2. 업로드 키 (한 번만)

PowerShell 창에서 직접 실행합니다(비밀번호를 두 번 묻습니다).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File android\play\upload-key.ps1
```

키는 `%USERPROFILE%\.pangmote-release\play-upload.jks`에 만들어지고 저장소 밖에 있습니다. **파일과 비밀번호를 함께 안전한 곳에
백업**하세요(USB, 비밀번호 관리자의 첨부 파일). 잃어버려도 Play App Signing이 앱 서명 키를 갖고 있어서 앱은 안전하고, Google에
업로드 키 재설정을 요청할 수 있지만 며칠이 걸립니다.

## 3. 번들 받기와 서명

CI(`Android app (builds)` 작업)가 커밋마다 서명하지 않은 번들을 만들어 30일 보관합니다(`pangmote-android-release-unsigned`).
에이전트가 `dist\android\`에 받아 두면, 직접 서명합니다(비밀번호를 묻습니다).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File android\play\sign-bundle.ps1 dist\android\app-release.aab
```

옆에 `app-release-signed.aab`가 생기고 서명이 확인됩니다. 이 파일을 Play Console에 올립니다.

## 4. Play Console 값

**앱 만들기:** 앱 이름 `Pangmote - 원격 데스크톱`, 기본 언어 한국어, 앱, 무료(한 번 무료로 내면 유료로 바꿀 수 없습니다).
신고 항목은 모두 사실대로: 개발자 프로그램 정책, 미국 수출법.

**스토어 등록정보:** `listing.md`의 글, `art/`의 그림. 영어(en-US) 번역을 추가하고 영어 그림을 넣습니다.
- 앱 카테고리: 생산성(Productivity). 태그는 원격 데스크톱 관련으로.
- 연락처: 이메일(필수, 공개), 웹사이트 `https://giukim.github.io/pangmote/`

**앱 콘텐츠 (정책 > 앱 콘텐츠):**

| 항목 | 답 |
|---|---|
| 개인정보처리방침 | `https://github.com/GiUKim/pangmote/blob/main/PRIVACY.md` (안드로이드 앱 항목 포함) |
| 광고 | 광고 없음 |
| 앱 액세스 | 일부 기능이 제한됨 → 아래 "검토자 안내"를 붙여 넣습니다 |
| 콘텐츠 등급 | 설문: 카테고리는 "유틸리티, 생산성, 커뮤니케이션, 기타". 폭력·성·언어·약물·도박 모두 아니요. 사용자 간 상호작용은 **예**(1회용 코드로 다른 사람의 PC 화면을 보고 조종할 수 있음), 위치 공유·디지털 상품 구매는 아니요 |
| 타겟층 | 만 18세 이상만 (아동 대상 아님) |
| 뉴스 앱 / 정부 앱 / 금융 기능 / 건강 | 아니요 / 아니요 / 없음 / 없음 |
| 광고 ID | 사용하지 않음 |
| 데이터 보안 | 아래 |

**데이터 보안(Data safety)** 의 답과 근거:
- 사용자 데이터를 수집하거나 공유하나요? → **아니요.**
  - 화면, 소리, 입력, 클립보드, 파일은 휴대폰과 사용자 PC 사이를 WebRTC로 종단간 암호화되어 오갑니다. 연결을 맺는 메시지도
    두 기기만 가진 키로 암호화되어 중계 서버(ntfy.sh)가 읽을 수 없습니다. Google 규정상 송신자와 수신자 외에는 읽을 수 없는
    종단간 암호화 데이터는 신고 대상이 아닙니다.
  - PC 목록과 기기 토큰은 휴대폰 안에만 있고(Android Keystore로 암호화, 백업 안 함), 카메라 영상은 QR을 읽는 데만 쓰고
    저장하거나 보내지 않습니다.
  - 개발자(이 프로젝트)가 운영하는 서버가 없고 분석·오류 보고 도구도 없습니다.
  - 판단이 필요한 한 가지: 공개 중계 서버와 STUN 서버(Google, Cloudflare)는 인터넷 연결의 성격상 휴대폰의 IP 주소를 봅니다.
    개발자가 받거나 보관하는 것이 아니어서 "수집 없음"으로 답하는 것을 권합니다. 신중하게 하려면 "대략적인 위치"를 "수집,
    앱 기능, 선택 아님"으로 적을 수도 있습니다.
- 전송 중 암호화: 예. 삭제 요청: 수집하는 데이터가 없어 해당 없음.

**검토자 안내 (앱 액세스에 붙여 넣기, 영어):**

```
Pangmote is a remote desktop client: it shows and controls the user's own PC, which runs the free Pangmote host. Without such a PC the app shows only its start screen. No account or login exists.

To try it:
1. On a Windows 10/11 PC, download https://github.com/GiUKim/pangmote/releases/latest/download/Pangmote-Windows-x64.zip, unzip it and run Pangmote.exe (Windows SmartScreen may warn: "More info" > "Run anyway"). Choose "Share this PC".
2. In the host window, under "Add a phone", press "Show QR code".
3. In the app, press "Add a PC with a QR code" and point the camera at that code. The PC's screen appears on the phone.
   Without a camera: in the host window press "Copy key", and in the app use "Connect with an access key" and type it.
4. One finger moves the pointer like a laptop's touchpad, a tap clicks, two fingers scroll and zoom.
```

## 5. 비공개 테스트

테스트 및 출시 > 테스트 > **비공개 테스트**에서 트랙을 만들고:
1. 테스터: 이메일 목록(Gmail 주소)을 만들어 넣습니다. 14~15명을 모으면 중간에 빠지는 사람이 있어도 12명이 유지됩니다.
2. 국가: 대한민국(테스터가 있는 나라 모두).
3. 새 버전 만들기: 서명한 `app-release-signed.aab`를 올리고, 출시 노트는 `listing.md`의 것. Play App Signing은 Google이
   만드는 키를 그대로 씁니다(권장값).
4. 검토 제출. 통과하면 **참여 링크**가 생깁니다.

테스터에게 보낼 안내(예):

```
Pangmote 안드로이드 앱 비공개 테스트에 참여해 주세요 (Android 11 이상).
1. 이 링크를 Play 스토어에 로그인된 Google 계정으로 엽니다: <참여 링크>
2. "테스터 되기"를 누르고, 이어지는 링크로 Play 스토어에서 설치합니다.
3. 14일 동안 지우지 말고 가끔 열어 주세요. PC가 있으면 https://github.com/GiUKim/pangmote 에서 호스트를 받아 연결해 보시고,
   불편한 점을 알려 주시면 고치겠습니다.
```

14일 동안 받은 의견과 고친 점을 적어 두세요. 프로덕션 신청서에 테스트를 어떻게 했는지, 무엇을 고쳤는지 묻습니다. 테스트
중에도 새 버전을 올릴 수 있습니다(기간은 테스터 참여로 셉니다).

**이미 시험 APK를 깐 휴대폰:** Play 버전과 서명이 달라서 위에 덮어 설치되지 않습니다. 시험 APK를 지우고 Play에서 설치하세요
(목록의 PC는 QR로 다시 추가합니다).

## 6. 스크린샷 (휴대폰에서 찍기)

`art/list-*.jpg` 외에 실제 접속 화면을 휴대폰에서 2~3장 찍어 주세요(PC 화면에 남에게 보여도 되는 것만 띄워 둡니다).
- 트랙패드로 커서를 움직이는 중인 PC 바탕화면이나 창
- 입력칸을 눌러 키보드가 올라온 모습(메모장 등에 글자를 치는 중)
- (모니터가 둘 이상이면) 두 손가락으로 옆으로 미는 중간

Play는 가로세로 비율이 2:1 이내여야 해서 Z Flip의 2640x1080 화면은 그대로 올릴 수 없습니다. 틀을 씌워 1920x1080으로 맞춥니다.

```powershell
node android\play\art.js frame <찍은 그림.png> dist\play\shot-1.jpg "노트북 터치패드처럼 정확하게" "한 손가락으로 커서를, 탭으로 클릭"
```

## 7. App Links (QR 링크가 앱에서 열리게)

Play에서 받은 앱은 Google의 앱 서명 키로 서명됩니다. 첫 업로드 뒤 **테스트 및 출시 > 앱 무결성 > 앱 서명**의
"앱 서명 키 인증서" **SHA-256 지문**을 알려 주시면(공개해도 되는 값입니다), `GiUKim.github.io`의
`.well-known/assetlinks.json`에 추가하겠습니다. 그 전에는 Play에서 받은 앱으로 휴대폰 카메라가 QR 링크를 열 때 앱 대신 브라우저가
열립니다(앱 안의 QR 버튼은 상관없이 됩니다).

## 8. 프로덕션과 그 뒤

14일이 지나면 대시보드의 **프로덕션 액세스 신청**을 누르고 설문에 답합니다. 승인되면 프로덕션 트랙에 같은 번들을 올리고
출시 국가를 고릅니다.

업데이트: `android/app/build.gradle`의 `versionCode`를 올리고(`versionName`도), 커밋해서 CI가 만든 번들을 서명해 올립니다.
같은 `versionCode`는 두 번 올릴 수 없습니다.
