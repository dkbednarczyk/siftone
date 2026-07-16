#!/usr/bin/env bash
set -euo pipefail

server_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_path="$server_dir/gonic.example.conf"
gonic_home="$HOME/.gonic"
pid_path="$gonic_home/gonic.pid"
log_path="$gonic_home/gonic.log"
db_path="$gonic_home/gonic.db"
listen_host="127.0.0.1"
listen_port="4747"
listen_addr="$listen_host:$listen_port"
base_url="http://$listen_addr"
gonic_user="${GONIC_USER:-admin}"
gonic_password="${GONIC_PASSWORD:-admin}"

ensure_directories() {
	mkdir -p "$gonic_home/cache" "$gonic_home/tmp" \
		"$gonic_home/podcasts" "$gonic_home/playlists"
}

is_running() {
	[[ -f "$pid_path" ]] && kill -0 "$(<"$pid_path")" 2>/dev/null
}

port_in_use() {
	if command -v ss >/dev/null 2>&1; then
		ss -ltn "sport = :$listen_port" | grep -q LISTEN
		return
	fi

	if command -v lsof >/dev/null 2>&1; then
		lsof -nP -iTCP:"$listen_port" -sTCP:LISTEN >/dev/null 2>&1
		return
	fi

	if (: >"/dev/tcp/$listen_host/$listen_port") >/dev/null 2>&1; then
		return 0
	fi

	return 1
}

subsonic_request() {
	curl --silent --show-error --fail --get \
		--user "$gonic_user:$gonic_password" \
		--data-urlencode "u=$gonic_user" \
		--data-urlencode "p=$gonic_password" \
		--data-urlencode "v=1.16.1" \
		--data-urlencode "c=siftone" \
		--data-urlencode "f=json" \
		"$base_url/rest/$1.view"
}

verify() {
	subsonic_request ping >/dev/null
	local tracks track_id
	tracks="$(sqlite3 "$db_path" "select count(*) from tracks;")"
	if [[ ! "$tracks" =~ ^[1-9][0-9]*$ ]]; then
		echo "Gonic has no indexed tracks." >&2
		exit 1
	fi
	track_id="$(sqlite3 "$db_path" "select id from tracks order by id limit 1;")"
	curl --silent --show-error --fail --get --range 0-4095 \
		--user "$gonic_user:$gonic_password" \
		--data-urlencode "id=$track_id" \
		--data-urlencode "u=$gonic_user" \
		--data-urlencode "p=$gonic_password" \
		--data-urlencode "v=1.16.1" \
		--data-urlencode "c=siftone-verify" \
		-o /dev/null \
		"$base_url/rest/stream.view"
	echo "Verified ping, $tracks indexed track(s), and a ranged stream."
}

start() {
	ensure_directories
	if is_running; then
		echo "Gonic is already running (PID $(<"$pid_path"))."
		return
	fi
	if port_in_use; then
		echo "Refusing to start: $listen_addr is already in use." >&2
		exit 1
	fi

	rm -f "$pid_path"
	nohup env TMPDIR="$gonic_home/tmp" gonic -config-path "$config_path" \
		>"$log_path" 2>&1 &
	echo $! >"$pid_path"

	for ((attempt = 0; attempt < 40; attempt += 1)); do
		if is_running && subsonic_request ping >/dev/null 2>&1; then
			echo "Gonic is ready at $base_url (PID $(<"$pid_path"))."
			return
		fi
		sleep 0.25
	done

	echo "Gonic did not become ready; see $log_path" >&2
	tail -n 80 "$log_path" >&2 || true
	exit 1
}

stop() {
	if ! is_running; then
		rm -f "$pid_path"
		echo "Gonic is not running."
		return
	fi

	local pid
	pid="$(<"$pid_path")"
	kill "$pid"
	for ((attempt = 0; attempt < 40; attempt += 1)); do
		if ! kill -0 "$pid" 2>/dev/null; then
			rm -f "$pid_path"
			echo "Stopped Gonic (PID $pid)."
			return
		fi
		sleep 0.25
	done
	echo "Gonic did not stop cleanly (PID $pid)." >&2
	exit 1
}

case "${1:-}" in
start) start ;;
stop) stop ;;
restart)
	stop
	start
	;;
status)
	if is_running; then
		echo "Gonic is running (PID $(<"$pid_path")) at $base_url."
	else
		echo "Gonic is not running."
		exit 1
	fi
	;;
logs) tail -n "${2:-100}" "$log_path" ;;
ping)
	subsonic_request ping
	echo
	;;
tracks) sqlite3 "$db_path" "select count(*) from tracks;" ;;
verify) verify ;;
scan)
	subsonic_request startScan
	echo
	;;
*)
	echo "Usage: $0 {start|stop|restart|status|logs [lines]|ping|tracks|verify|scan}" >&2
	exit 2
	;;
esac
