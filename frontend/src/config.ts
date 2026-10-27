// 폰(근로자 앱)에서 같은 와이파이로 접속할 때도 되도록 지금 연 주소의 호스트를 그대로 쓴다
export const BACKEND_URL = `http://${window.location.hostname}:8000`
// 감리 감사 저장소: 시공사 백엔드와 별도 서비스. 감리 화면은 시공사 백엔드를 거치지 않고 여기와 체인만 본다
export const AUDIT_URL = `http://${window.location.hostname}:8100`
// 게이트 기기 서비스: 기기 키·YOLO를 가진 쪽. 키오스크는 시공사 백엔드가 아니라 여기로 검사를 보낸다
export const GATE_URL = `http://${window.location.hostname}:8200`
export const RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com'
export const CONTRACT_ADDRESS = '0x082f20bC3dCcFB393bed97Cdc75E6C2DFd2f4d05' as const
// 로컬 체인이면 탐색기 링크 없음
export const EXPLORER_URL = /127\.0\.0\.1|localhost/.test(RPC_URL) ? '' : 'https://sepolia.etherscan.io'
