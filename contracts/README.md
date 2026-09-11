## SafetyGate 컨트랙트

Foundry 기반. `lib/`는 gitignore 처리되어 있으므로 클론 후 아래 명령으로 의존성을 설치한다.

```shell
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
```

### Build / Test

```shell
forge build
forge test -vv
```
