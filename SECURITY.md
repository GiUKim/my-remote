# 보안 정책 / Security policy

My Remote는 PC의 화면과 입력을 통째로 넘기는 프로그램입니다. 접속 키 없이 PC에 들어오거나, 키를 빼내거나,
잠금 화면의 비밀번호를 우회하거나, 업데이트에 다른 코드를 끼워 넣을 수 있는 문제를 찾았다면 **공개 이슈로 올리지 말고**
GitHub의 비공개 신고(저장소의 **Security → Report a vulnerability**)로 알려 주세요. 확인되는 대로 답하고, 고친 버전을
내보낸 뒤에 공개합니다.

My Remote hands over a PC's screen and input. If you find a way in without the access key, to read the key,
to get past the lock screen's password, or to slip other code into an update, please **do not open a public
issue**: report it privately through GitHub (**Security → Report a vulnerability** on this repository). It
will be answered as soon as it is checked and made public once a fixed version is out.

What the design relies on (details in the README's "보안" section):

- Every signaling message is encrypted and authenticated with keys derived from the 32-byte access key; the
  media channel is trusted through the DTLS fingerprints inside those messages.
- Updates install only when their manifest verifies with the Ed25519 keys built into the app, and the files
  match the manifest.
- The Windows lock screen support (`MyRemoteAssist`, LocalSystem) injects input only while the session is
  locked, never into a UAC prompt, and serves only the signed-in user of that session.

Supported: the latest release. 지원 대상은 최신 릴리스입니다.
