// 근로자 패스키(WebAuthn). 키는 폰의 패스키 저장소에 만들어지고 브라우저·서버 모두 개인키를 꺼낼 수 없다.
// 서명할 때마다 Face ID·지문 확인(userVerification: required)이 필요하다. 새 라이브러리 없이 브라우저 API만 쓴다.

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// 패스키는 https 또는 localhost에서만 동작한다 (같은 와이파이의 http://IP 주소에서는 안 됨)
export function passkeyUnavailableReason(): string | null {
  if (!window.isSecureContext) return 'https 주소로 열어야 패스키를 쓸 수 있어요. (같은 와이파이의 http 주소에서는 안 돼요)'
  if (!('PublicKeyCredential' in window)) return '이 브라우저는 패스키를 지원하지 않아요.'
  return null
}

export type RegisterOptions = { challenge: string; userId: string; userName: string; rpName: string; timeout: number }
export type LoginOptions = { challenge: string; credentialIds: string[]; timeout: number }

export async function createPasskey(o: RegisterOptions, displayName: string) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(o.challenge),
      rp: { id: window.location.hostname, name: o.rpName },
      user: { id: b64urlToBytes(o.userId), name: o.userName, displayName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 (P-256)
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      timeout: o.timeout,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('패스키를 만들지 못했어요')
  const res = cred.response as AuthenticatorAttestationResponse
  const publicKey = res.getPublicKey()
  if (!publicKey) throw new Error('이 기기는 ES256 패스키를 지원하지 않아요')
  return {
    credentialId: bytesToB64url(cred.rawId),
    publicKey: bytesToB64url(publicKey),
    clientDataJSON: bytesToB64url(res.clientDataJSON),
    authenticatorData: bytesToB64url(res.getAuthenticatorData()),
  }
}

export async function signWithPasskey(o: LoginOptions) {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(o.challenge),
      rpId: window.location.hostname,
      allowCredentials: o.credentialIds.map((id) => ({ type: 'public-key' as const, id: b64urlToBytes(id) })),
      userVerification: 'required',
      timeout: o.timeout,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('패스키 서명을 받지 못했어요')
  const res = cred.response as AuthenticatorAssertionResponse
  return {
    credentialId: bytesToB64url(cred.rawId),
    clientDataJSON: bytesToB64url(res.clientDataJSON),
    authenticatorData: bytesToB64url(res.authenticatorData),
    signature: bytesToB64url(res.signature),
  }
}

// 사용자가 Face ID를 취소했을 때는 오류 대신 안내만 한다
export function friendlyPasskeyError(e: unknown): string {
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
    return 'Face ID 확인이 취소됐어요. 다시 시도해 주세요.'
  }
  if (e instanceof DOMException && e.name === 'InvalidStateError') {
    return '이 기기에 이미 등록된 패스키가 있어요. 로그인 화면에서 시작해 주세요.'
  }
  return e instanceof Error ? e.message : String(e)
}
