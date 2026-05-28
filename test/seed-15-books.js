// 种子脚本：向 IndexedDB 注入 15 本大文本书籍，模拟真实用户数据
// 使用方法：在浏览器 console 中运行，或用 Playwright page.evaluate() 注入

(function seedFifteenBooks() {
  const DB_NAME = 'app_book_content_v1';
  const STORE_NAME = 'book_contents';
  const BOOK_COUNT = 15;
  // 每本书的目标大小 ~800KB-1.5MB（模拟真实中文小说）
  const TARGET_SIZE_MIN = 800 * 1024;
  const TARGET_SIZE_MAX = 1500 * 1024;

  // 中文段落模板
  const SAMPLE_PARAGRAPHS = [
    '夜色渐深，窗外的梧桐树叶在微风中沙沙作响。他坐在书桌前，手指轻轻敲击着桌面，目光落在那一叠泛黄的信纸上。这些信是他从老家的阁楼里找到的，每一封都记录着一段尘封已久的往事。信纸上的字迹娟秀而有力，看得出写信人曾经受过良好的教育。他小心翼翼地翻开最上面的一封信，纸张的边缘已经有些破损，但字迹依然清晰可辨。',
    '春天的早晨总是带着一种特别的清新。院子里的桃花开了，粉色的花瓣在晨光中显得格外娇嫩。她提着一壶刚烧开的水，慢慢地走到院子中央的石桌旁。石桌上放着一套紫砂茶具，是去年在宜兴买的。她喜欢在清晨泡一壶龙井，看着茶叶在水中慢慢舒展开来，那是一种难以言喻的宁静。',
    '这条路他已经走了三年。从家门到地铁站，经过那座小桥，穿过那条种满银杏树的街道。秋天的银杏叶像一把把金色的小扇子，铺满了整条人行道。他曾经试过数这些树，一共是四十七棵。每天早上七点十五分出门，走到第三十二棵银杏树的时候，会看到那位遛狗的老人。老人的狗是一只金毛，总是摇着尾巴，看起来很温顺。',
    '宇宙是如此的浩瀚，而人类的存在不过是其中微不足道的一瞬。当我们仰望星空时，那闪烁的光点可能是数百万年前就已经发出的。光年，这个单位本身就暗示着人类的渺小。然而，正是这种渺小，反而激发了人类无尽的好奇心。从伽利略第一次将望远镜对准天空，到如今詹姆斯·韦伯太空望远镜传回的那些令人惊叹的图像，人类对宇宙的探索从未停止。',
    '厨房里弥漫着红烧肉浓郁的香味。这道菜他已经做了二十年，从最初的手忙脚乱到现在的游刃有余。选用五花肉最为关键，三层肥两层瘦最为理想。先将肉切成均匀的方块，冷水下锅焯去血水。锅中放少许油，加入冰糖小火慢炒，待糖色变成琥珀色时放入肉块翻炒。再加入葱姜蒜、八角、桂皮，倒入料酒和酱油，最后加入没过肉块的热水，大火烧开后转小火慢炖。',
    '机器学习正在改变我们生活的方方面面。从推荐系统到自动驾驶，从医疗诊断到自然语言处理，人工智能的应用已经深入到各行各业。深度学习模型的参数量从最初的几百万发展到现在的数千亿，计算能力的需求也呈指数级增长。然而，在这快速发展的背后，我们也需要思考：这些模型真正理解它们在处理的内容吗？还是仅仅在统计意义上建立了输入与输出之间的关联？',
    '大海有着无穷的魅力。站在沙滩上，看着一波又一波的海浪涌来又退去，仿佛时间在这一刻变得缓慢。海风吹拂着脸庞，带着咸咸的味道。远处，海天一色，分不清哪里是海的尽头，哪里是天的开始。偶尔有几只海鸥掠过海面，发出清脆的叫声。沙滩上的贝壳在阳光下闪闪发光，每一个都有着独特的纹路和色彩。',
    '在经济学中，供需关系是最基本的原理之一。当市场上某种商品的供给量大于需求量时，价格往往会下降；反之，当需求大于供给时，价格则会上升。这个看似简单的规律，在实际应用中却需要考虑诸多因素：消费者的偏好变化、替代品的出现、政府的政策干预、国际市场的影响等等。每个因素都像一只看不见的手，在调节着市场的平衡。',
    '冬天的第一场雪总是让人格外期待。雪花纷纷扬扬地从灰蒙蒙的天空中飘落，像无数白色的蝴蝶在空中起舞。大地很快就披上了一层洁白的外衣。孩子们兴奋地冲出家门，在雪地里奔跑嬉戏，堆雪人、打雪仗，脸上洋溢着纯真的笑容。大人们则更多地担心出行的不便，开始铲除门前的积雪，为汽车装上防滑链。',
    '贝多芬的第九交响曲被誉为音乐史上最伟大的作品之一。当最后一个乐章的《欢乐颂》响起时，那种震撼人心的力量让无数听众热泪盈眶。有趣的是，贝多芬在创作这部作品时已经完全失聪。他听不到自己谱写的音符，却能在脑海中构建出如此宏伟的音乐殿堂。这或许就是天才与常人的区别——他们能够在黑暗中看见光明，在寂静中听见声音。',
    '日本的茶道讲究「一期一会」。每一次茶会都是独一无二的，因为同样的人、同样的时间、同样的地点不可能再次重现。这种哲学思想深深影响了日本人的生活方式和审美观念。茶室通常很小，只有四叠半榻榻米的面积。客人需要低头弯腰才能进入，这种设计象征着谦逊和平等。在茶室中，无论身份贵贱，都需要放下身段，平等相待。',
    '量子力学是二十世纪物理学最伟大的革命之一。波粒二象性告诉我们，微观粒子既可以是粒子，也可以是波，取决于我们如何观测它们。薛定谔的猫这个思想实验更是将量子力学的反直觉特性推向了极致：一只猫可以同时处于生与死的叠加态，直到我们打开盒子进行观测。这种不确定性原理不仅挑战了经典物理学的决定论，也引发了关于现实本质的深刻哲学讨论。',
    '丝绸之路不仅仅是一条贸易路线，更是连接东西方文明的纽带。从长安出发，经过河西走廊，穿越塔克拉玛干沙漠，翻越帕米尔高原，最终到达地中海沿岸。这条路线全长超过七千公里，商队需要花费数月甚至数年的时间才能走完全程。沿途的敦煌莫高窟中保存着大量精美的壁画和雕塑，见证了那个时代辉煌的文化交流。',
    '咖啡是全球最受欢迎的饮品之一。从埃塞俄比亚的咖啡起源传说到今天遍布世界各地的咖啡馆，咖啡文化已经经历了上千年的演变。不同国家有着不同的咖啡饮用习惯：意大利人偏爱浓缩咖啡，一小杯在几秒钟内喝完；土耳其咖啡则需要在铜壶中慢慢煮沸，喝的时候还要注意底部沉淀的咖啡渣；而美国的滴滤咖啡则以量大、口感清淡著称。',
    '登山是一种独特的体验。当你一步一步地向上攀登，周围的空气变得越来越稀薄，每一步都需要付出更多的努力。但当你终于站在山顶，俯瞰脚下云海翻涌，那种成就感和自由感是难以用语言描述的。珠穆朗玛峰作为世界最高峰，每年吸引着数百名登山者前来挑战。然而在这壮丽的自然景观背后，也隐藏着巨大的危险——雪崩、冰裂缝、高原反应，任何一个小小的失误都可能付出生命的代价。',
    '古埃及的金字塔是人类建筑史上的奇迹。胡夫金字塔原高一百四十六米，在埃菲尔铁塔建成之前，它保持了世界最高建筑的纪录长达三千八百年之久。建造金字塔需要精确的天文学和数学知识——塔的四面几乎完美地指向东南西北四个方向，误差不超过零点一度。至今，考古学家们仍在争论古埃及人是如何将这些重达数吨的巨石运送到如此高的位置。',
    '人工智能的伦理问题日益受到关注。当自动驾驶汽车面临不可避免的事故时，它应该优先保护乘客还是行人？当面部识别技术被用于大规模监控时，个人隐私如何得到保障？当算法决定了谁能获得贷款、谁能被录用时，如何确保这些决策的公平性？这些问题没有简单的答案，需要技术人员、伦理学家、法律专家和政策制定者共同探讨。',
    '茶马古道是中国西南地区一条重要的古代商道。马帮驮着茶叶从云南出发，穿越横断山脉，经过西藏，最终到达尼泊尔和印度。这条路线的艰险程度远超丝绸之路——陡峭的悬崖、湍急的河流、多变的天气，每年都有许多马帮在这条路上失去生命。然而，正是这条古道，将中国的茶文化传播到了南亚次大陆，也促进了藏传佛教在内地的传播。',
    '巴赫的音乐被认为是巴洛克时期的巅峰。他的《平均律钢琴曲集》被誉为钢琴音乐的「旧约全书」。巴赫的音乐风格严谨而富有逻辑，每一个音符都经过精心的设计和安排。他擅长运用对位法，将多个独立的旋律线巧妙地编织在一起，形成复杂而和谐的音乐织体。尽管巴赫生前并未获得广泛的认可，但他的作品在去世后被重新发现，对后世音乐产生了深远的影响。',
    '珊瑚礁是海洋中的热带雨林。虽然它们只占海洋面积的不到百分之一，却孕育了约四分之一的海洋生物种类。珊瑚虫是一种微小的动物，它们与体内的虫黄藻形成共生关系。虫黄藻通过光合作用为珊瑚提供能量，而珊瑚则为虫黄藻提供保护。然而，全球变暖导致海水温度上升，使得珊瑚虫排出体内的虫黄藻，从而出现珊瑚白化现象。',
  ];

  // 生成指定大小的中文文本
  function generateChineseText(targetBytes) {
    const encoder = new TextEncoder();
    let text = '';
    let paraIndex = 0;

    while (encoder.encode(text).length < targetBytes) {
      // 添加段落
      const para = SAMPLE_PARAGRAPHS[paraIndex % SAMPLE_PARAGRAPHS.length];
      text += para + '\n\n';
      paraIndex++;

      // 每5段加入一个章节标题
      if (paraIndex % 5 === 0) {
        const chapterNum = Math.floor(paraIndex / 5) + 1;
        text += `第${chapterNum}章\n\n`;
      }
    }

    // 精确裁剪到目标大小
    let bytes = encoder.encode(text);
    while (bytes.length > targetBytes) {
      text = text.slice(0, -100);
      bytes = encoder.encode(text);
    }

    return text;
  }

  // 生成章节结构
  function generateChapters(fullText) {
    const chapters = [];
    const lines = fullText.split('\n');
    let currentChapter = { title: '第1章', content: '' };
    let chapterIndex = 1;

    for (const line of lines) {
      if (line.startsWith('第') && line.includes('章') && line.length < 20) {
        if (currentChapter.content.trim()) {
          chapters.push({ ...currentChapter });
        }
        chapterIndex++;
        currentChapter = { title: line.trim(), content: '' };
      } else if (line.trim()) {
        currentChapter.content += line + '\n';
      }
    }

    if (currentChapter.content.trim()) {
      chapters.push(currentChapter);
    }

    return chapters;
  }

  // 生成书籍元数据
  const BOOK_TITLES = [
    '时光信笺', '春日的茶', '银杏街道', '星辰大海',
    '厨房的秘密', '算法之美', '海的呼吸', '市场的舞蹈',
    '雪落无声', '永恒的旋律', '一期一会', '量子之门',
    '丝路行记', '杯中世界', '山巅之上',
  ];

  const AUTHORS = [
    '林清玄', '张晓风', '余华', '刘慈欣',
    '汪曾祺', '吴军', '余光中', '薛兆丰',
    '迟子建', '傅雷', '川端康成', '曹天元',
    '陈舜臣', '韩怀宗', '马丽华',
  ];

  function generateBooksMetadata() {
    return BOOK_TITLES.map((title, i) => ({
      id: `seed-book-${String(i + 1).padStart(2, '0')}`,
      title,
      author: AUTHORS[i],
      coverUrl: '',
      progress: Math.floor(Math.random() * 100),
      lastRead: new Date(Date.now() - Math.floor(Math.random() * 30) * 86400000).toISOString(),
      fullTextLength: 0, // will be updated after content generation
      chapterCount: 0,
    }));
  }

  // 主流程
  async function seed() {
    console.log('[种子脚本] 开始生成15本书的测试数据...');
    const startTime = performance.now();

    // 1. 打开 IndexedDB
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    console.log('[种子脚本] IndexedDB 已打开');

    // 2. 生成并写入15本书
    const books = generateBooksMetadata();
    let totalBytes = 0;

    for (let i = 0; i < BOOK_COUNT; i++) {
      const targetSize = TARGET_SIZE_MIN + Math.floor(Math.random() * (TARGET_SIZE_MAX - TARGET_SIZE_MIN));
      const fullText = generateChineseText(targetSize);
      const chapters = generateChapters(fullText);
      const encoder = new TextEncoder();
      const actualBytes = encoder.encode(fullText).length;

      const storedContent = {
        fullText,
        chapters,
        readerState: {
          readingPosition: {
            chapterIndex: 0,
            chapterCharOffset: Math.floor(Math.random() * 1000),
            globalCharOffset: Math.floor(Math.random() * 5000),
            scrollRatio: Math.random(),
            totalLength: fullText.length,
            updatedAt: Date.now(),
          },
        },
        bookSummaryCards: [],
        bookAutoSummaryLastEnd: 0,
      };

      // 写入 IndexedDB
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(storedContent, books[i].id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      books[i].fullTextLength = fullText.length;
      books[i].chapterCount = chapters.length;
      totalBytes += actualBytes;

      console.log(`[种子脚本] 第${i + 1}本书「${books[i].title}」已写入，${(actualBytes / 1024).toFixed(0)} KB，${chapters.length}章`);
    }

    db.close();

    // 3. 写入 localStorage
    localStorage.setItem('app_books', JSON.stringify(books));
    console.log(`[种子脚本] localStorage app_books 已写入，${books.length}本书`);

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    console.log(`[种子脚本] 完成！总计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB，耗时 ${elapsed}s`);
    console.log('[种子脚本] 现在可以调用 testExportArchive() 来测试序列化');

    return { bookCount: BOOK_COUNT, totalBytes, elapsed };
  }

  // 测试导出函数
  window.testExportArchive = async function() {
    console.log('[测试] 开始测试 createAppArchivePayload...');
    const startTime = performance.now();

    try {
      // 动态导入 appArchive 模块
      const module = await import('/read-something/utils/appArchive.ts');
      const createAppArchivePayload = module.createAppArchivePayload;

      console.log('[测试] createAppArchivePayload 已加载，开始调用...');
      const payload = await createAppArchivePayload();

      const step1Time = performance.now();
      console.log(`[测试] createAppArchivePayload 完成，耗时 ${((step1Time - startTime) / 1000).toFixed(1)}s`);
      console.log(`[测试] bookContents 数量: ${Object.keys(payload.indexedDb.bookContents).length}`);
      console.log(`[测试] localStorage keys: ${Object.keys(payload.localStorage).length}`);

      // 测试 JSON.stringify
      console.log('[测试] 开始 JSON.stringify...');
      const json = JSON.stringify(payload);
      const step2Time = performance.now();
      const sizeBytes = new TextEncoder().encode(json).length;
      console.log(`[测试] JSON.stringify 完成，耗时 ${((step2Time - step1Time) / 1000).toFixed(1)}s`);
      console.log(`[测试] JSON 大小: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(`[测试] JSON 第一个字符: "${json[0]}", 最后一个字符: "${json[json.length - 1]}"`);
      console.log(`[测试] 总耗时 ${((step2Time - startTime) / 1000).toFixed(1)}s`);

      return {
        success: true,
        bookCount: Object.keys(payload.indexedDb.bookContents).length,
        jsonSizeBytes: sizeBytes,
        jsonSizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
        totalTime: ((step2Time - startTime) / 1000).toFixed(1),
      };
    } catch (err) {
      console.error('[测试] 导出或序列化失败！', err);
      return {
        success: false,
        error: err.message || String(err),
        stack: err.stack,
      };
    }
  };

  // 测试模拟上传（使用 fetch）
  window.testUploadSimulation = async function() {
    console.log('[测试] 模拟上传：createAppArchivePayload → JSON.stringify → 检查 body 大小...');
    const result = await window.testExportArchive();

    if (!result.success) {
      console.error('[测试] 导出阶段已失败，跳过上传模拟');
      return result;
    }

    console.log(`[测试] 如果进行 HTTP POST，body 大小将是 ${result.jsonSizeMB} MB`);
    console.log('[测试] 注：后端未运行时，实际 fetch 会失败，这里只验证序列化环节');
    return result;
  };

  // 执行
  seed().catch(err => {
    console.error('[种子脚本] 失败:', err);
  });
})();
