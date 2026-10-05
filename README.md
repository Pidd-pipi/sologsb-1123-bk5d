# sologsb-1123 无人机航拍航线与成果编目台（gbdronemap）

面向航拍作业与测绘内业人员：先按测区规划航线与航点（重叠率、相对航高、地面分辨率），再按**真实续航模型把航点顺序编排成架次**（山区长悬停/多段折返不再按总耗时平均切），最后对飞行产出的成果影像逐张编目并关联架次版本（片号、GSD、重叠度、质量、架次归属）。范围只覆盖**航线规划**、**架次编排**与**成果影像编目**本身。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21823**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 地图 | 高德地图 JS API 2.0（可选，key 缺失时自动退化） |
| 本地存储 | IndexedDB（Dexie 4），缩略图单独建表，含结构版本号与升级迁移 |

## VITE_AMAP_KEY 配置与退化行为（重要）

- key 从环境变量 `VITE_AMAP_KEY` 读取（`.env` / `.env.example` 中已留空）。
- **未配置 key（默认）**：`<AmapRouteView>` 自动渲染**本地 SVG 网格视图**——按经纬度等比投影，仍可绘制测区边界、航点折线、每个航点的视场矩形，并支持**点击网格新增航点**。此模式下页面**不发起任何外部网络请求**。
- **配置了 key**：动态加载 `https://webapi.amap.com/maps?v=2.0&key=...`，用高德地图绘制多边形 / 折线 / 航点 / 视场矩形。
- **构建与运行都不依赖该 key**：`vite.config.ts` 与 Dockerfile 均不校验 key；即使填了 key 但脚本加载失败或 8 s 超时，也会自动退化为 SVG 网格视图，页面顶部用 `Alert` 标明当前模式。

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite build
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1123/
├── docker-compose.yml
├── .env.example           # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── index.css
        ├── vite-env.d.ts
        ├── router/index.tsx
        ├── types/{mission,waypoint,flightline,imageasset,sortie}.ts
        ├── stores/{mission,waypoint,asset,sortie}Store.ts
        ├── components/common/{AmapRouteView,OverlapCalcPanel,AssetGrid,MissionCard}.tsx
        ├── hooks/{useMissionFilter,useRouteMetrics,useSortiePlan}.ts
        ├── pages/{MissionList,RoutePlanner,SortiePlanner,WaypointTable,AssetCatalog,CameraPreset}.tsx
        └── utils/{db,geoCalc,sortiePlan,amapLoader,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/missions` | 任务台账：按测区/机型/飞行日期区间/状态筛选，显示航线数、预计张数与成果条目数 | Mission |
| `/missions/:id/route` | 航线规划主视图：地图/网格绘制测区与航点折线，右侧参数面板改航高/航速/重叠率，实时回算 GSD、航线间距、预计张数与耗时；下方展示当前架次计划摘要 | Mission、Waypoint、FlightLine、SortiePlan |
| `/missions/:id/sorties` | 架次编排：从起降点出发按航点顺序装架（20 min × 80% 预算），单点超容量拒绝并写明原因；版本史、标记已执行、按架次编目成果 | SortiePlan、Sortie、Waypoint、Mission |
| `/missions/:id/waypoints` | 航点明细：经纬度粘贴导入、批量改高度、上下移与拖拽换序、单点视场预览 | Waypoint |
| `/missions/:id/assets` | 成果影像编目：卡片格子列出片号/缩略图/GSD/质量/架次归属，多选标记质量、按架次筛选、定位到图、导出清单 | ImageAsset、Sortie |
| `/settings/camera` | 相机与传感器参数预设管理，选定预设后带入任务的焦距/像元/传感器 | CameraPreset、Mission |

`/` 重定向到 `/missions`，未匹配路由同样兜底到 `/missions`。

## 关键算法

- **地面分辨率**：`GSD(cm/px) = 像元尺寸(μm) × 航高(m) / (焦距(mm) × 10)`
- **地面幅宽**：`幅宽(m) = 传感器尺寸(mm) × 航高(m) / 焦距(mm)`
- **航线间距** = 旁向幅宽 × (1 − 旁向重叠率)；**拍照间隔** = 航向幅宽 × (1 − 航向重叠率)
- **预计张数** = Σ(每条航带长度 / 拍照间隔 + 1)；**预计耗时** = (总航程 / 航速 + 转弯与悬停附加) / 60；**电池组数** 按 20 min 有效续航向上取整
- **测区面积**：经纬度投影到米制后用鞋带公式；**航带路径长度**：逐段球面近似距离累加

### 架次编排模型（`/missions/:id/sorties`）

- **单架次预算** = 20 min 标称续航 × (1 − 20% 预留电量) = **16 min（960 s）**，去程、连续航段、悬停、拍照、回程全部计入。
- **计时模型**：每架次从**起降点**出发 → 爬升至首航点（爬升 3 m/s）→ 按航点顺序飞连续航段（水平距离 ÷ 该点航速，高差按爬升 3 m/s、下降 2.5 m/s 计，每航点 4 s 转弯附加）→ 悬停点计入悬停秒数 → 拍照附加 2 s/张（张数 = 航段长 ÷ 拍照间隔，**随相机预设的传感器/焦距变化**）→ 末航点返航起降点。
- **装架**：按航点顺序贪心装架，含回程仍装得下就继续；装不下就封架、以该点另起一架；**单点往返也超容量 → 拒绝该点并写明原因**（各段耗时与预算数值），其余航点继续编排。
- **失效重算**：航点高度/顺序/经纬度/航速/悬停、相机预设（传感器/焦距/像元）、起降点任一变化 → 输入指纹变化 → 当前计划**立即失效并重算**（300 ms 防抖，批量修改只算一次）；旧版本置「已失效」，其未飞架次置「已取消」。
- **已执行架次冻结**：重算只为「未被已执行架次覆盖」的航点排新架次，架次号任务内单调递增不复用；成果影像编目时记录 `sortieId + planVersion`，**关联当时版本**，计划变更后归属仍可追溯。
- **失败保底**：计划级输入无效（未设起降点、相机焦距/传感器为零等）→ 本次记为「重算失败」版本，**上一版可执行计划原样保留**；修正数据后指纹变化自动重算并继续。

## 数据存储说明

- 数据库名 `gbdronemap`，当前结构版本 **v3**（`localStorage['gbdronemap:db-version']` 记录）。
- 八张表：`missions`（任务，含起降点 `homePoint`）、`waypoints`（航点）、`lines`（航线参数）、`assets`（成果影像条目，含 `sortieId`/`planVersion` 架次归属）、`thumbs`（**缩略图单独建表**，dataUrl）、`presets`（相机预设）、`sortiePlans`（架次计划版本，含指纹/状态/失败原因/单点拒绝记录）、`sorties`（架次，含各段耗时拆解与状态）。
- v1 → v2 迁移：为老任务补 `areaPolygon`/传感器默认值，为航线补 `updatedAt`/`batteryCount`，并新增索引。
- v2 → v3 迁移：新增 `sortiePlans`/`sorties` 两表；任务补 `homePoint`（缺省取测区边界首点）；`assets` 增加 `sortieId` 索引。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范任务、5 个航点、2 条航线参数、1 个架次计划版本（任务 A 的架次 #1 已执行）、6 条成果影像条目（含缩略图，关联该架次与版本）与 3 套相机预设。
