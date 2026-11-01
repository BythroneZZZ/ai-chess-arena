# Third-Party Notices · AI CHESS ARENA

本项目的 `index.html` 内联了第三方组件。发布时请随包提供本文件。

---

## 1. chess.js 0.10.3

- 用途：合法着法生成、FEN/PGN 解析、走法校验（作为唯一真源）
- 来源：https://github.com/jhlywa/chess.js
- 许可证：**BSD-2-Clause**
- 版权：Copyright (c) 2020, Jeff Hlywa (jhlywa@gmail.com)
- 内联位置：`index.html` 中 `<script>` 块开头带注释 `chess.js 0.10.3`
- 修改：无（原样内联）

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## 2. Stockfish 10 (asm.js build)

- 用途：人机 / AI 对战的着法计算
- 来源：https://github.com/niklasf/stockfish.js （JavaScript/WebAssembly 编译：Niklas Fiekas）
- 上游：https://github.com/ddugovic/Stockfish （Multi-Variant 分支）
- 许可证：**GNU GPL v3**
- 内联位置：`index.html` 中 `<script type="text/plain" id="sf-src">`
- 修改：无。运行时从内联文本构造 Blob 并作为 Worker 启动

### GPLv3 合规提示（重要）

Stockfish 以 GPLv3 分发。将其内联进单个 HTML 文件并随本项目发布时：

1. **必须**随发行包提供 GPLv3 全文与本声明。
2. **必须**提供获取完整对应源码的方式。由于本内联文件未做修改，可直接指向：
   - https://github.com/niklasf/stockfish.js （对应版本的 `stockfish.js`）
   - https://github.com/ddugovic/Stockfish
3. 若你修改了 Stockfish 本体，则**必须**公开修改后的源码。
4. 本项目其余代码（游戏逻辑、UI、角色系统）为独立作品，不因聚合分发而被 GPL 传染；但如果你把 Stockfish 与本项目代码**合并**为单一作品分发，需自行评估整体许可。

GPLv3 全文：https://www.gnu.org/licenses/gpl-3.0.txt

---

## 3. Press Start 2P

- 用途：英文/数字像素字体
- 来源：https://fonts.google.com/specimen/Press+Start+2P
- 作者：CodeMan38
- 许可证：**SIL Open Font License 1.1**
- 内联位置：`index.html` 的 `@font-face` base64 data URI
- 修改：无（woff2 原文件内联）

OFL 全文：https://scripts.sil.org/OFL

---

## 4. Fusion Pixel Font（缝合像素字体）

- 用途：中文像素字体
- 来源：https://github.com/TakWolf/fusion-pixel-font
- 许可证：**SIL Open Font License 1.1**
- 组成字体及其许可：
  - Ark Pixel Font — OFL 1.1
  - Cubic 11 — OFL 1.1
  - Galmuri — OFL 1.1
- 内联文件：`fusion-pixel-12px-proportional-zh_hans.ttf.woff2`
- 修改：无

---

## 5. ZzFX

- 用途：音效合成（本项目按其参数约定重新实现了等价的单函数合成器）
- 来源：https://github.com/KilledByAPixel/ZzFX
- 作者：Frank Force
- 许可证：**MIT**
- 说明：`04_render.js` 中的 `Sound.zzfx()` 为独立实现，沿用 ZzFX 的参数顺序与波形公式

---

## 6. 本项目自有代码

游戏逻辑、像素渲染、角色系统、Prompt 生成器、API 客户端、UI 样式均为原创。
像素棋子与角色立绘由代码在运行时生成（无外部素材）。
