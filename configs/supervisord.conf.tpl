; Supervisord config template. $VARS are expanded by scripts/start.sh via envsubst.
; DO NOT edit the rendered configs/supervisord.conf — edit this .tpl.

[unix_http_server]
file=$ROOT_DIR/logs/supervisor.sock

[supervisord]
logfile=$LOGS_DIR/supervisord.log
pidfile=$LOGS_DIR/supervisord.pid
childlogdir=$LOGS_DIR
nodaemon=false
silent=false

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix://$ROOT_DIR/logs/supervisor.sock

; ---------------------------------------------------------------------------
; vLLM-Omni backends (one per task type)
; ---------------------------------------------------------------------------

[program:vllm_customvoice]
command=$ROOT_DIR/.venv/bin/vllm-omni serve $CUSTOMVOICE_MODEL_PATH
        --omni
        --host $CUSTOMVOICE_HOST
        --port $CUSTOMVOICE_PORT
        --trust-remote-code
        --deploy-config $ROOT_DIR/configs/qwen3_tts_dgx.yaml
environment=
    CUDA_VISIBLE_DEVICES="0",
    VLLM_WORKER_MULTIPROC_METHOD="spawn"
directory=$ROOT_DIR
autostart=true
autorestart=true
startretries=3
startsecs=30
stopasgroup=true
killasgroup=true
stopwaitsecs=30
stdout_logfile=$LOGS_DIR/customvoice.log
stderr_logfile=$LOGS_DIR/customvoice.log
stdout_logfile_maxbytes=20MB
stdout_logfile_backups=3

[program:vllm_voicedesign]
command=$ROOT_DIR/.venv/bin/vllm-omni serve $VOICEDESIGN_MODEL_PATH
        --omni
        --host $VOICEDESIGN_HOST
        --port $VOICEDESIGN_PORT
        --trust-remote-code
        --deploy-config $ROOT_DIR/configs/qwen3_tts_dgx.yaml
environment=
    CUDA_VISIBLE_DEVICES="0",
    VLLM_WORKER_MULTIPROC_METHOD="spawn"
directory=$ROOT_DIR
autostart=true
autorestart=true
startretries=3
startsecs=30
stopasgroup=true
killasgroup=true
stopwaitsecs=30
stdout_logfile=$LOGS_DIR/voicedesign.log
stderr_logfile=$LOGS_DIR/voicedesign.log
stdout_logfile_maxbytes=20MB
stdout_logfile_backups=3

[program:vllm_base]
command=$ROOT_DIR/.venv/bin/vllm-omni serve $BASE_MODEL_PATH
        --omni
        --host $BASE_HOST
        --port $BASE_PORT
        --trust-remote-code
        --deploy-config $ROOT_DIR/configs/qwen3_tts_dgx.yaml
environment=
    CUDA_VISIBLE_DEVICES="0",
    VLLM_WORKER_MULTIPROC_METHOD="spawn"
directory=$ROOT_DIR
autostart=true
autorestart=true
startretries=3
startsecs=30
stopasgroup=true
killasgroup=true
stopwaitsecs=30
stdout_logfile=$LOGS_DIR/base.log
stderr_logfile=$LOGS_DIR/base.log
stdout_logfile_maxbytes=20MB
stdout_logfile_backups=3

; ---------------------------------------------------------------------------
; Orchestrator (public-facing)
; ---------------------------------------------------------------------------

[program:orchestrator]
command=$ROOT_DIR/.venv/bin/uvicorn orchestrator.app:app
        --host $ORCH_HOST
        --port $ORCH_PORT
        --proxy-headers
        --no-access-log
directory=$ROOT_DIR
environment=
    PYTHONPATH="$ROOT_DIR",
    QWENTTS_ENV_FILE="$ROOT_DIR/.env"
autostart=true
autorestart=true
startretries=5
startsecs=3
stopasgroup=true
killasgroup=true
stdout_logfile=$LOGS_DIR/orchestrator.log
stderr_logfile=$LOGS_DIR/orchestrator.log
stdout_logfile_maxbytes=20MB
stdout_logfile_backups=3

[group:qwentts]
programs=vllm_customvoice,vllm_voicedesign,vllm_base,orchestrator
