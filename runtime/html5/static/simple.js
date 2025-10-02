/**
 * FunASR 简洁页面业务脚本
 * 该脚本在保留 index.html 中使用的 Recorder 录音库与接口协议的前提下，
 * 仅实现“连接、断开、开始、停止”四类控制，满足最小化 Demo 的需求。
 */
(function () {
  "use strict";

  /**
   * WebSocket ASR 服务地址（根据需求硬编码即可，无需用户输入）。
   * 如果部署地址发生变化，只需要在此处调整常量即可。
   */
  const ASR_SERVER_URL = "ws://127.0.0.1:10095/";

  /**
   * 当检测到连续静音达到 SILENCE_GAP_MS 毫秒后，认为当前语句结束，
   * 下一次有声段的识别结果将自动换行显示。
   */
  const SILENCE_GAP_MS = 8000;

  /**
   * Recorder.onProcess 回调提供的实时能量值范围为 0~100，
   * 当能量值低于该阈值时，可认为当前帧接近静音。
   */
  const SILENCE_THRESHOLD = 0;

  /**
   * 发送给服务端的 PCM 采样点数，960 个 16 kHz 采样点约等于 60 ms 音频，
   * 与原页面保持一致，可确保后端按帧正常解码。
   */
  const PCM_CHUNK_SIZE = 960;

  // 页面中的控件引用，便于统一管理状态与文案。
  const connectBtn = document.getElementById("btnConnect");
  const disconnectBtn = document.getElementById("btnDisconnect");
  const startBtn = document.getElementById("btnStart");
  const stopBtn = document.getElementById("btnStop");
  const statusLabel = document.getElementById("status");
  const resultBox = document.getElementById("resultBox");

  // WebSocket 连接实例；未连接时为 null。
  let socket = null;
  // Recorder 实例，沿用 index.html 使用的 Recorder 录音库。
  const recorder = Recorder({
    type: "pcm",
    bitRate: 16,
    sampleRate: 16000,
    onProcess: handleAudioProcess,
  });

  // 标记当前是否已经建立连接、是否正在录音。
  let isConnected = false;
  let isRecording = false;

  /**
   * speechActive 仅用于在前端内部标记当前语音段是否处于“讲话中”，
   * 以便结合静音检测实现自动换行；与发送给服务端的 is_speaking 控制位解耦。
   */
  let speechActive = false;
  /**
   * awaitingNewLine 在静音超时后置为 true，下一次收到文本时自动换行。
   */
  let awaitingNewLine = false;
  /**
   * 记录最近一次检测到“有声”帧的时间戳，用于静音检测。
   */
  let lastSpeechTimestamp = 0;

  /**
   * pendingCloseMessage 用于在 WebSocket 关闭前缓存需要展示的提示语，
   * 例如手动断开或连接异常时的特定文案；若为空则使用默认提示。
   */
  let pendingCloseMessage = "";

  /**
   * 累计尚未发送的 Int16 PCM 数据。Recorder.SampleData 会返回 Int16Array，
   * 这里沿用原页面的写法，将多个片段拼接后按 PCM_CHUNK_SIZE 拆包发送。
   */
  let pendingPcm = new Int16Array();

  /**
   * 文本展示使用数组存储每一行内容，方便在需要换行时直接 push 新元素。
   */
  const resultLines = [""];
  let currentLineIndex = 0;

  /**
   * 绑定四个按钮的事件处理。
   */
  connectBtn.addEventListener("click", handleConnectClick);
  disconnectBtn.addEventListener("click", handleDisconnectClick);
  startBtn.addEventListener("click", handleStartClick);
  stopBtn.addEventListener("click", handleStopClick);

  /**
   * 点击“连接”按钮时创建 WebSocket，复用 index.html 的握手结构，
   * 以确保与 FunASR WebSocket 服务兼容。
   */
  function handleConnectClick() {
    if (isConnected || socket) {
      return;
    }

    updateStatus("正在连接 ASR 服务，请稍候...");
    connectBtn.disabled = true;
    disconnectBtn.disabled = true;

    socket = new WebSocket(ASR_SERVER_URL);
    // 仅发送文本消息与 PCM 数组，这里沿用默认 binaryType。

    socket.onopen = () => {
      isConnected = true;
      updateStatus("连接成功，请点击“开始”开始录音。");
      startBtn.disabled = false;
      disconnectBtn.disabled = false;
	  resultBox.value="";
	  resultLines.length=0;
	  resultLines.push("");
	  currentLineIndex = 0
    };

    socket.onmessage = handleSocketMessage;

    socket.onclose = () => {
      const message =
        pendingCloseMessage || "连接已断开，如需继续请重新连接。";
      pendingCloseMessage = "";
      resetConnectionState(message);
    };

    socket.onerror = () => {
      pendingCloseMessage = "连接失败，请检查服务端是否可用。";
      updateStatus(pendingCloseMessage);
      if (socket) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        } else {
          resetConnectionState(pendingCloseMessage);
        }
      }
    };
  }

  /**
   * 点击“断开”按钮时主动关闭 WebSocket 连接。若正在录音，会先发送
   * 停止录音的控制帧，确保后端完整接收最后一段音频数据。
   */
  function handleDisconnectClick() {
    if (!socket || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      return;
    }

    pendingCloseMessage = "已手动断开连接，可重新点击“连接”。";

    if (isRecording) {
      // 复用停止录音流程，发送 is_speaking=false 以及剩余的音频数据。
      handleStopClick();
    }

    updateStatus("正在断开连接...");
    try {
      socket.close();
    } catch (error) {
      console.warn("手动关闭 WebSocket 异常：", error);
      pendingCloseMessage = "";
      resetConnectionState("连接已断开，如需继续请重新连接。");
    }
  }

  /**
   * 点击“开始”时打开麦克风并启动录音，
   * 同时向服务端发送首个 is_speaking=true 的控制帧。
   */
  function handleStartClick() {
    if (!isConnected || !socket || socket.readyState !== WebSocket.OPEN) {
      updateStatus("未连接到 ASR 服务，无法开始录音。");
      return;
    }
    if (isRecording) {
      return;
    }

    recorder.open(
      () => {
        recorder.start();
        isRecording = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        updateStatus("正在录音，保持话语即可。");

        // 初始化静音检测相关状态。
        lastSpeechTimestamp = Date.now();
        speechActive = true;
        awaitingNewLine = false;
        pendingPcm = new Int16Array();
        sendSpeakingState(true);
      },
      (msg) => {
        updateStatus("无法访问麦克风：" + msg);
        startBtn.disabled = false;
        stopBtn.disabled = true;
      }
    );
  }

  /**
   * 点击“停止”按钮时结束录音，发送 is_speaking=false 标记并保留连接。
   */
  function handleStopClick() {
    if (!isRecording) {
      return;
    }
    isRecording = false;

    recorder.stop(
      () => {
        recorder.close();
      },
      (msg) => {
        console.warn("停止录音失败：", msg);
      }
    );

    flushPendingPcm();
    sendSpeakingState(false);
    speechActive = false;
    awaitingNewLine = true;

    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateStatus("录音已停止，可再次点击“开始”继续。");
  }

  /**
   * WebSocket 收到文本结果时更新 textarea，
   * 如 awaitingNewLine 为 true，则先换行再追加文本。
   */
  function handleSocketMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      console.warn("收到无法解析的消息：", event.data);
      return;
    }

    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text) {
      return;
    }
console.log(awaitingNewLine);
    if (awaitingNewLine) {
      // 如果上一段已经结束且有新的文本到达，添加新行。
      awaitingNewLine = false;
	  speechActive = true;
      if (resultLines[currentLineIndex].length > 0) {
        resultLines.push("");
        currentLineIndex = resultLines.length - 1;
      }
    }

    resultLines[currentLineIndex] += text;
    resultBox.value = resultLines.join("\n");
  }

  /**
   * Recorder 提供的实时回调，负责：
   * 1. 将采集到的音频转换成 16 kHz Int16 PCM；
   * 2. 累积并按固定帧长发送至后端；
   * 3. 依据能量值检测静音，触发自动换行逻辑。
   */
  function handleAudioProcess(
    buffers,
    powerLevel,
    bufferDuration,
    bufferSampleRate
  ) {
    if (!isRecording || !socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    // Recorder 的 buffers 是按帧累积的数组，取末尾一帧做重采样可减少计算量。
    const floatFrame = buffers[buffers.length - 1];
    const resampled = Recorder.SampleData([floatFrame], bufferSampleRate, 16000).data;

    if (resampled.length > 0) {
      // 将新数据拼接到待发送数组中。
      const merged = new Int16Array(pendingPcm.length + resampled.length);
      merged.set(pendingPcm);
      merged.set(resampled, pendingPcm.length);
      pendingPcm = merged;
    }

    // 按固定帧长拆包发送，确保与后端协议兼容。
    while (pendingPcm.length >= PCM_CHUNK_SIZE) {
      const chunk = pendingPcm.slice(0, PCM_CHUNK_SIZE);
      pendingPcm = pendingPcm.slice(PCM_CHUNK_SIZE);
      socket.send(chunk.buffer);
    }
	console.log(powerLevel,awaitingNewLine);
    const now = Date.now();
    if (powerLevel > SILENCE_THRESHOLD) {
      // 检测到讲话，刷新时间戳。
      lastSpeechTimestamp = now;
      // 静音后重新检测到讲话时，仅恢复前端状态，保持与 index.html 一致的控制帧节奏。
      //if (!speechActive) {
        speechActive = true;
       // awaitingNewLine = false;
      //}
    } else if (speechActive && now - lastSpeechTimestamp > SILENCE_GAP_MS) {
      // 静音超过设定阈值，结束当前语句并准备换行。
      flushPendingPcm();
	  speechActive = false;
      awaitingNewLine = true;
	  
    }
  }

  /**
   * 将累计的 PCM 数据一次性发送，避免尾帧丢失。
   */
  function flushPendingPcm() {
    if (pendingPcm.length === 0 || !socket || socket.readyState !== WebSocket.OPEN) {
      pendingPcm = new Int16Array();
      return;
    }
    socket.send(pendingPcm.buffer);
    pendingPcm = new Int16Array();
  }

  /**
   * 发送 FunASR WebSocket 协议所需的控制帧。
   * 为保持与 index.html 一致，simple 页面只会在整体开始/停止录音时通知 is_speaking，
   * 静音检测仅用于前端分行展示，不影响控制帧。
   */
  function sendSpeakingState(isSpeaking) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const request = {
      chunk_size: [5, 10, 5],
      wav_name: "simple-demo",
      chunk_interval: 10,
      itn: false,
      mode: "2pass",
      is_speaking: isSpeaking,
    };
    socket.send(JSON.stringify(request));
  }

  /**
   * 连接断开或出错时，统一恢复按钮与状态。
   */
  function resetConnectionState(message) {
    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      } catch (error) {
        console.warn("关闭 WebSocket 异常：", error);
      }
    }
    socket = null;
    isConnected = false;
    isRecording = false;
    speechActive = false;
    awaitingNewLine = false;
    pendingPcm = new Int16Array();
    pendingCloseMessage = "";

    connectBtn.disabled = false;
    startBtn.disabled = true;
    stopBtn.disabled = true;
    disconnectBtn.disabled = true;

    updateStatus(message || "请先点击“连接”按钮。");
  }

  /**
   * 更新页面顶部状态提示，统一在此处修改以便维护。
   */
  function updateStatus(message) {
    statusLabel.textContent = message;
  }

  // 初始化状态栏文本，确保在未能正确解析 HTML 默认文字时也能显示。
  updateStatus("请先点击“连接”按钮。");
})();