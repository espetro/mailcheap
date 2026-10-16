#!/usr/bin/env bash
# Compares status, content-type, cache-control, location and body hash of Next (3100) and the edge (3200) for the same requests.
cd "$(dirname "$0")"
sig() { # method url [curl args]
	local m=$1 u=$2; shift 2
	local h; h=$(curl -s -o /tmp/parity-body -D - -X "$m" "$@" "$u" | tr -d '\r' | awk 'NR==1{print $2} tolower($0) ~ /^(content-type|cache-control|location):/{print tolower($0)}' | sort)
	if [ "$m" = HEAD ]; then echo "$h"; else echo "$h body=$(shasum < /tmp/parity-body | cut -c1-12) len=$(wc -c < /tmp/parity-body | tr -d ' ')"; fi
}
check() { # label method path [curl args]
	local label=$1 m=$2 p=$3; shift 3
	local a b; a=$(sig "$m" "127.0.0.1:3100$p" "$@"); b=$(sig "$m" "127.0.0.1:3200$p" "$@")
	if [ "$a" = "$b" ]; then echo "MATCH   $label"; else echo "DIFF    $label"; echo "  next: $a" | tr '\n' ' '; echo; echo "  edge: $b" | tr '\n' ' '; echo; fi
}
O=$(sed -n 5p out/open.txt); C=$(sed -n 5p out/click.txt); U=$(sed -n 5p out/unsub.txt)
UA=(-H "User-Agent: Mozilla/5.0")
check "GET /o valid" GET "$O"
check "GET /o forged" GET /o/forged
check "GET /c signed" GET "$C" "${UA[@]}"
check "HEAD /c signed" HEAD "$C" "${UA[@]}" -I
check "GET /c malformed" GET /c/xxx "${UA[@]}"
check "POST unsubscribe one-click" POST "$U" -H "List-Unsubscribe: One-Click" -d "List-Unsubscribe=One-Click"
check "POST unsubscribe bad token" POST "/api/unsubscribe?token=bad" -d "List-Unsubscribe=One-Click"
