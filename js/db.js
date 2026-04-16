// Database Module using sql.js

import { logger } from './utils/logger.js';

export let db = null;
let SQL = null;
let suppressSave = false;
let pendingSave = false;

// saveDB debounce — art arda yazma işlemlerini birleştirerek max 1500ms'de bir kayıt yapar
const SAVE_DEBOUNCE_MS = 1500;
let saveDebounceTimer = null;
let saveImmediate = false;

const DB_CONFIG = {
    dbName: 'kpss_db'
};

export async function initDB() {
    if (db) return db;

    try {
        // Load SQL.js
        SQL = await initSqlJs({
            locateFile: file => chrome.runtime.getURL(`lib/${file}`)
        });

        // Check if we have saved data in storage
        const stored = await chrome.storage.local.get(DB_CONFIG.dbName);

        if (stored[DB_CONFIG.dbName]) {
            // Load existing DB
            const data = stored[DB_CONFIG.dbName];
            // Handle both Array (old) and Uint8Array (new) formats for robustness
            const uInt8Array = (data instanceof Uint8Array) ? data : new Uint8Array(data);
            db = new SQL.Database(uInt8Array);
            logger.log('Database loaded from storage.');

            // Run migrations if needed
            suppressSave = true;
            pendingSave = false;
            migrateQuestionsTable();
            migrateTodayTasksTable();
            migrateNotesTable();
            createStudyHistoryTable();
            migrateTrialsTable();
            migrateResourcesTable();
            migrateTopicsTable();
            migrateResourceLinking();
            migrateHabitsTable();
            suppressSave = false;
            if (pendingSave) {
                pendingSave = false;
                saveDB();
            }
        } else {
            // Create new DB
            db = new SQL.Database();
            logger.log('New database created.');
            suppressSave = true;
            pendingSave = false;
            createTables();
            migrateResourceLinking(); // Run migrations even on new DB to ensure consistency
            // REMOVED: populateDefaultData() - User will add topics from resources
            saveDB();
            suppressSave = false;
            if (pendingSave) {
                pendingSave = false;
                saveDB();
            }
        }

        return db;
    } catch (err) {
        logger.error('Database initialization failed:', err);
        throw err;
    }
}

function migrateQuestionsTable() {
    try {
        // Check if topic_id exists
        db.exec("SELECT topic_id FROM questions LIMIT 1");
    } catch (e) {
        logger.log('Migrating questions table for topic_id...');
        // Easier to drop/recreate for now since it's early phase
        db.run("DROP TABLE IF EXISTS questions");

        db.run(`
        CREATE TABLE IF NOT EXISTS questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject TEXT,
          topic_id INTEGER references topics(id),
          resource_id INTEGER,
          image_storage_key TEXT,
          next_review INTEGER,
          interval INTEGER DEFAULT 0,
          ease_factor REAL DEFAULT 2.5,
          status INTEGER DEFAULT 0, -- 0:New, 1:Learning, 2:Review
          created_at INTEGER
        );
        `);
        saveDB();
    }
}

function migrateNotesTable() {
    try {
        // Check if topic_id exists
        db.exec("SELECT topic_id FROM notes LIMIT 1");

        // Check if audio_storage_key exists
        try {
            db.exec("SELECT audio_storage_key FROM notes LIMIT 1");
        } catch (e) {
            logger.log('Migrating: Adding audio_storage_key to notes...');
            db.run("ALTER TABLE notes ADD COLUMN audio_storage_key TEXT");
        }
    } catch (e) {
        logger.log("Migrating: Upgrading notes table...");
        // Drop and recreate for internal use (simplest for now)
        db.run("DROP TABLE IF EXISTS notes");
        db.run(`
            CREATE TABLE IF NOT EXISTS notes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              subject TEXT,
              topic_id INTEGER,
              resource_id INTEGER,
              content TEXT,
              image_storage_key TEXT,
              audio_storage_key TEXT,
              next_review INTEGER,
              interval INTEGER DEFAULT 0,
              ease_factor REAL DEFAULT 2.5,
              status INTEGER DEFAULT 0, -- 0:New, 1:Learning, 2:Review
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        saveDB();
    }
}

function createStudyHistoryTable() {
    let didChange = false;

    // Only create table if missing (avoid forcing save on every startup)
    try {
        db.exec("SELECT 1 FROM study_history LIMIT 1");
    } catch (_) {
        db.run(`
            CREATE TABLE IF NOT EXISTS study_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              topic_id INTEGER,
              subject TEXT,
              duration_seconds INTEGER DEFAULT 0,
              solved_questions INTEGER DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        didChange = true;
    }

    // Migration for existing users
    try {
        db.exec("SELECT subject FROM study_history LIMIT 1");
    } catch (e) {
        logger.log("Migrating: Adding subject column to study_history...");
        db.run("ALTER TABLE study_history ADD COLUMN subject TEXT");
        didChange = true;
        // Backfill subject if missing by joining with topics
        try {
            db.run(`
                UPDATE study_history 
                SET subject = (SELECT subject FROM topics WHERE topics.id = study_history.topic_id)
                WHERE subject IS NULL
            `);
        } catch (err) { logger.error("Backfill failed:", err); }
    }

    try {
        db.exec("SELECT solved_questions FROM study_history LIMIT 1");
    } catch (e) {
        logger.log("Migrating: Adding solved_questions to study_history...");
        db.run("ALTER TABLE study_history ADD COLUMN solved_questions INTEGER DEFAULT 0");
        didChange = true;
    }

    if (didChange) saveDB();
}

function migrateTrialsTable() {
    // Only create if missing (avoid forcing save on every startup)
    try {
        db.exec("SELECT 1 FROM trials LIMIT 1");
        return;
    } catch (_) {
        // Table missing, create it
    }

    db.run(`
            CREATE TABLE IF NOT EXISTS trials (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              type TEXT, -- Lisans, Onlisans
              turkish_d INTEGER DEFAULT 0, turkish_y INTEGER DEFAULT 0,
              math_d INTEGER DEFAULT 0, math_y INTEGER DEFAULT 0,
              history_d INTEGER DEFAULT 0, history_y INTEGER DEFAULT 0,
              geography_d INTEGER DEFAULT 0, geography_y INTEGER DEFAULT 0,
              constitution_d INTEGER DEFAULT 0, constitution_y INTEGER DEFAULT 0,
              total_net REAL DEFAULT 0,
              score REAL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
    saveDB();
}

function migrateResourcesTable() {
    let didChange = false;
    try {
        // Create table only if missing (avoid forcing save on every startup)
        try {
            db.exec("SELECT 1 FROM resources LIMIT 1");
        } catch (_) {
            db.run(`
                CREATE TABLE IF NOT EXISTS resources (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  subject TEXT,
                  name TEXT,
                  type TEXT,
                  note TEXT,
                  sort_order INTEGER DEFAULT 0,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            didChange = true;
        }

        try {
            db.exec("SELECT note FROM resources LIMIT 1");
        } catch (e) {
            logger.log("Migrating: Adding note column to resources...");
            db.run("ALTER TABLE resources ADD COLUMN note TEXT");
            didChange = true;
        }
        try {
            db.exec("SELECT status FROM resources LIMIT 1");
        } catch (e) {
            logger.log("Migrating: Adding status column to resources...");
            db.run("ALTER TABLE resources ADD COLUMN status INTEGER DEFAULT 0");
            didChange = true;
        }
        try {
            db.exec("SELECT pdf_storage_key FROM resources LIMIT 1");
        } catch (e) {
            logger.log("Migrating: Adding PDF columns to resources...");
            db.run("ALTER TABLE resources ADD COLUMN pdf_storage_key TEXT");
            db.run("ALTER TABLE resources ADD COLUMN last_page INTEGER DEFAULT 1");
            didChange = true;
        }
    } catch (e) { logger.error("Resources migration failed:", e); }

    // Annotations Migration
    try {
        try {
            db.exec("SELECT 1 FROM resource_annotations LIMIT 1");
        } catch (_) {
            db.run(`
                CREATE TABLE IF NOT EXISTS resource_annotations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    resource_id INTEGER,
                    page_number INTEGER,
                    canvas_data TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            didChange = true;
        }
    } catch (e) { logger.error("Annotations migration failed:", e); }

    if (didChange) saveDB();
}

function migrateResourceLinking() {
    let didChange = false;
    try {
        db.exec("SELECT resource_id FROM notes LIMIT 1");
    } catch (e) {
        logger.log("Migrating: Adding resource_id to notes...");
        db.run("ALTER TABLE notes ADD COLUMN resource_id INTEGER");
        didChange = true;
    }
    try {
        db.exec("SELECT resource_id FROM questions LIMIT 1");
    } catch (e) {
        logger.log("Migrating: Adding resource_id to questions...");
        db.run("ALTER TABLE questions ADD COLUMN resource_id INTEGER");
        didChange = true;
    }
    try {
        db.exec("SELECT resource_id FROM study_history LIMIT 1");
    } catch (e) {
        logger.log("Migrating: Adding resource_id to study_history...");
        db.run("ALTER TABLE study_history ADD COLUMN resource_id INTEGER");
        didChange = true;
    }
    if (didChange) saveDB();
}


function migrateTopicsTable() {
    try {
        db.exec("SELECT description FROM topics LIMIT 1");
    } catch (e) {
        logger.log("Migrating: Adding description column to topics...");
        db.run("ALTER TABLE topics ADD COLUMN description TEXT");
        saveDB();
    }
}

function migrateHabitsTable() {
    try {
        let didChange = false;

        // Ensure table exists (avoid unconditional save)
        try {
            db.exec("SELECT 1 FROM habits LIMIT 1");
        } catch (_) {
            db.run(`
                CREATE TABLE IF NOT EXISTS habits (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    target_count INTEGER DEFAULT 1,
                    current_count INTEGER DEFAULT 0,
                    last_reset_date TEXT,
                    order_index INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            `);
            didChange = true;
        }

        // Check if order_index column exists
        const checkStmt = db.prepare("PRAGMA table_info(habits)");
        let hasOrderIndex = false;
        while (checkStmt.step()) {
            const col = checkStmt.getAsObject();
            if (col.name === 'order_index') {
                hasOrderIndex = true;
                break;
            }
        }
        checkStmt.free();
        
        if (!hasOrderIndex) {
            // Add order_index column
            db.run("ALTER TABLE habits ADD COLUMN order_index INTEGER DEFAULT 0");
            // Set order_index for existing habits based on created_at
            const updateStmt = db.prepare("SELECT id FROM habits ORDER BY created_at ASC");
            let index = 0;
            while (updateStmt.step()) {
                const row = updateStmt.getAsObject();
                db.run("UPDATE habits SET order_index = ? WHERE id = ?", [index, row.id]);
                index++;
            }
            updateStmt.free();
            didChange = true;
        }
        if (didChange) saveDB();
    } catch (e) {
        logger.error("Habits migration failed:", e);
    }
}

function migrateTodayTasksTable() {
    try {
        db.exec("SELECT 1 FROM today_tasks LIMIT 1");

        // Check if topic_id is TEXT or INTEGER
        // If table exists but topic_id is INTEGER, we need to recreate it
        // SQLite doesn't support ALTER COLUMN TYPE, so we need to recreate
        const tableInfo = db.exec("PRAGMA table_info(today_tasks)");
        if (tableInfo.length > 0) {
            const columns = tableInfo[0].values;
            const topicIdColumn = columns.find(col => col[1] === 'topic_id');
            if (topicIdColumn && topicIdColumn[2] === 'INTEGER') {
                logger.log('Migrating: Updating today_tasks.topic_id to TEXT...');
                // Backup data
                const backup = db.exec("SELECT * FROM today_tasks");
                // Drop and recreate
                db.run("DROP TABLE today_tasks");
                db.run(`
                    CREATE TABLE today_tasks(
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        topic_id TEXT,
                        subject TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                // Restore data
                if (backup.length > 0) {
                    backup[0].values.forEach(row => {
                        db.run("INSERT INTO today_tasks (id, topic_id, subject, created_at) VALUES (?, ?, ?, ?)", row);
                    });
                }
                saveDB();
            }
        }
    } catch (e) {
        logger.log("Migrating: Creating today_tasks table...");
        db.run(`
            CREATE TABLE IF NOT EXISTS today_tasks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id TEXT,
    subject TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);
        saveDB();
    }
}

function createTables() {
    // Topics Table with ordering and progress
    db.run(`
    CREATE TABLE IF NOT EXISTS topics(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status INTEGER DEFAULT 0, --0: Not Started, 1: Progress, 2: Done
      order_index INTEGER DEFAULT 0
);
`);

    // Notes Table
    db.run(`
    CREATE TABLE IF NOT EXISTS notes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT,
    topic_id INTEGER,
    resource_id INTEGER,
    content TEXT,
    image_storage_key TEXT,
    audio_storage_key TEXT,
    next_review INTEGER,
    interval INTEGER DEFAULT 0,
    ease_factor REAL DEFAULT 2.5,
    status INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

    // Questions Table
    // Questions Table (SRS)
    db.run(`
    CREATE TABLE IF NOT EXISTS questions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT,
    topic_id INTEGER references topics(id),
    resource_id INTEGER,
    image_storage_key TEXT,
    next_review INTEGER,
    interval INTEGER DEFAULT 0,
    ease_factor REAL DEFAULT 2.5,
    status INTEGER DEFAULT 0, --0: New, 1: Learning, 2: Review
      created_at INTEGER
);
`);

    // Today's Work List Table
    db.run(`
    CREATE TABLE IF NOT EXISTS today_tasks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id TEXT,
    subject TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

    // Study History Table
    db.run(`
    CREATE TABLE IF NOT EXISTS study_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER,
      resource_id INTEGER,
      subject TEXT,
      duration_seconds INTEGER DEFAULT 0,
      solved_questions INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

    // Trials Table
    db.run(`
    CREATE TABLE IF NOT EXISTS trials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      turkish_d INTEGER DEFAULT 0, turkish_y INTEGER DEFAULT 0,
      math_d INTEGER DEFAULT 0, math_y INTEGER DEFAULT 0,
      history_d INTEGER DEFAULT 0, history_y INTEGER DEFAULT 0,
      geography_d INTEGER DEFAULT 0, geography_y INTEGER DEFAULT 0,
      constitution_d INTEGER DEFAULT 0, constitution_y INTEGER DEFAULT 0,
      total_net REAL DEFAULT 0,
      score REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

    // Resources Table
    db.run(`
    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT,
      name TEXT,
      type TEXT,
      note TEXT,
      status INTEGER DEFAULT 0, -- 0: In Progress, 1: Finished
      sort_order INTEGER DEFAULT 0,
      pdf_storage_key TEXT,
      last_page INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

    // Resource Annotations Table
    db.run(`
        CREATE TABLE IF NOT EXISTS resource_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id INTEGER,
      page_number INTEGER,
      canvas_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

    // Habits Table (Daily habits with counters)
    db.run(`
        CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_count INTEGER DEFAULT 1,
      current_count INTEGER DEFAULT 0,
      last_reset_date TEXT,
      order_index INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

    logger.log('Tables created.');
}

async function populateDefaultData() {
    const subjects = {
        'matematik': [
            { name: "Temel Kavramlar", desc: "Sayı kümeleri, tek-çift sayılar, pozitif-negatif sayılar." },
            { name: "Ardışık Sayılar", desc: "Sayı dizileri ve toplam formülleri." },
            { name: "Sayı Basamakları", desc: "Çözümleme ve basamak değeri işlemleri." },
            { name: "Bölme ve Bölünebilme Kuralları", desc: "Asal sayılar, tam bölen sayısı." },
            { name: "Asal Sayılar, OBEB ve OKEK", desc: "En büyük ortak bölen ve en küçük ortak kat hesaplamaları." },
            { name: "Rasyonel Sayılar ve Ondalık Sayılar", desc: "Dört işlem ve sıralama." },
            { name: "Basit Eşitsizlikler", desc: "Aralık kavramı ve eşitsizlik özellikleri." },
            { name: "Mutlak Değer", desc: "Tanımı ve mutlak değerli denklemler/eşitsizlikler." },
            { name: "Üslü Sayılar", desc: "Üslü ifadelerde işlemler ve denklemler." },
            { name: "Köklü Sayılar", desc: "Kök dışına çıkarma ve eşlenik işlemleri." },
            { name: "Çarpanlara Ayırma", desc: "Özdeşlikler ve sadeleştirme soruları." },
            { name: "Denklemler", desc: "Birinci dereceden bir ve iki bilinmeyenli denklemler." },
            { name: "Oran - Orantı", desc: "Doğru ve ters orantı problemleri." },
            { name: "Sayı ve Kesir Problemleri", desc: "Denklem kurma becerisi gerektiren sorular." },
            { name: "Yaş Problemleri", desc: "Güncel ve geçmiş zaman hesaplamaları." },
            { name: "İşçi Problemleri", desc: "İş yapma süreleri ve kapasite hesapları." },
            { name: "Yüzde, Kar-Zarar ve Faiz Problemleri", desc: "Alış-satış ve kar oranları." },
            { name: "Karışım Problemleri", desc: "Madde oranları ve yeni karışım hesapları." },
            { name: "Hareket Problemleri", desc: "Yol, hız ve zaman ilişkisi." },
            { name: "Grafik Problemleri", desc: "Sütun, çizgi ve daire grafiklerini yorumlama." },
            { name: "Kümeler", desc: "Küme işlemleri ve Venn şeması problemleri." },
            { name: "Fonksiyonlar", desc: "Tanım kümesi, değer kümesi ve bileşke fonksiyonlar." },
            { name: "Permütasyon, Kombinasyon ve Olasılık", desc: "Sayma kuralları ve olasılık hesapları." },
            { name: "Modüler Aritmetik ve İşlem", desc: "Kalan sınıfları ve tanımlı işlemler." },
            { name: "Sayısal Mantık", desc: "Şekil yeteneği, akıl yürütme ve sözel olmayan mantık soruları." },
            { name: "Doğruda ve Üçgende Açılar", desc: "Temel açı kuralları." },
            { name: "Üçgende Açı-Kenar Bağıntıları", desc: "Kenarlar arası eşitsizlikler ve açı ilişkileri." },
            { name: "Özel Üçgenler", desc: "Dik, ikizkenar ve eşkenar üçgen özellikleri." },
            { name: "Üçgende Yardımcı Elemanlar", desc: "Açıortay ve kenarortay bağıntıları." },
            { name: "Üçgende Benzerlik ve Alan", desc: "Benzerlik oranları ve alan hesaplama formülleri." },
            { name: "Çokgenler", desc: "İç ve dış açılar, kenar özellikleri." },
            { name: "Dörtgenler", desc: "Paralelkenar, eşkenar dörtgen, dikdörtgen, kare ve yamuk." },
            { name: "Çember ve Daire", desc: "Açılar, teğetler, çevre ve alan hesaplamaları." },
            { name: "Analitik Geometri", desc: "Noktanın ve doğrunun analitiği." },
            { name: "Katı Cisimler", desc: "Prizma, piramit, silindir, koni ve kürenin alan ve hacimleri." },
            { name: "Denemeler", desc: "Çözülmüş deneme soruları ve analizler" }
        ],
        'turkce': [
            { name: "Sözcükte Anlam", desc: "Gerçek, mecaz, yan anlam, terim anlam, söz öbekleri, deyimler ve atasözleri." },
            { name: "Cümlede Anlam", desc: "Cümle yorumu, kesin yargı çıkarma, neden-sonuç, amaç-sonuç ve koşul cümleleri." },
            { name: "Paragrafta Anlam", desc: "Ana fikir, yardımcı düşünceler, paragraf tamamlama, akışı bozan cümle ve paragrafı ikiye bölme." },
            { name: "Ses Bilgisi", desc: "Ünlü daralması, ünsüz benzeşmesi, ünlü düşmesi ve diğer ses olayları." },
            { name: "Sözcükte Yapı", desc: "Kök, gövde, yapım ve çekim ekleri." },
            { name: "Sözcük Türleri", desc: "İsim, sıfat, zamir, zarf, edat, bağlaç, ünlem ve fiiller." },
            { name: "Cümlenin Ögeleri", desc: "Özne, yüklem, nesne ve tümleçler." },
            { name: "Cümle Türleri", desc: "Anlamına, yüklemin yerine ve yapısına göre cümleler." },
            { name: "Yazım Kuralları", desc: "Büyük harflerin kullanımı, birleşik sözcüklerin yazımı ve sayıların yazımı." },
            { name: "Noktalama İşaretleri", desc: "Virgül, noktalı virgül, iki nokta ve diğer işaretlerin kullanımı." },
            { name: "Anlatım Bozuklukları", desc: "Anlamsal ve yapısal bozukluklar." },
            { name: "Sözel Mantık", desc: "Mantıksal akıl yürütme, tablo ve grafik yorumlama." },
            { name: "Denemeler", desc: "Çözülmüş deneme soruları ve analizler" }
        ],
        'tarih': [
            { name: "İslamiyet Öncesi Türk Tarihi", desc: "Kültür ve Uygarlık dahil" },
            { name: "İlk Türk-İslam Devletleri", desc: "Kültür ve Uygarlık dahil" },
            { name: "Osmanlı Devleti Kuruluş Dönemi", desc: "Beylikten Devlete Geçiş" },
            { name: "Osmanlı Devleti Yükselme Dönemi", desc: "Dünya Gücü Osmanlı" },
            { name: "Osmanlı Devleti Kültür ve Uygarlık", desc: "Devlet Yönetimi, Ordu, Toplum, Ekonomi" },
            { name: "XVII. Yüzyıl Osmanlı Devleti", desc: "Duraklama Dönemi ve Islahatları" },
            { name: "XVIII. Yüzyıl Osmanlı Devleti", desc: "Gerileme Dönemi ve Islahatları" },
            { name: "XIX. Yüzyıl Osmanlı Devleti", desc: "Dağılma Dönemi ve Islahatları" },
            { name: "XX. Yüzyıl Başlarında Osmanlı Devleti", desc: "Trablusgarp, Balkan Savaşları, I. Dünya Savaşı" },
            { name: "Kurtuluş Savaşı Hazırlık Dönemi", desc: "Genelgeler ve Kongreler" },
            { name: "I. TBMM Dönemi", desc: "Meclis Yapısı ve Faaliyetleri" },
            { name: "Kurtuluş Savaşı Muharebeler Dönemi", desc: "Cepheler ve Antlaşmalar" },
            { name: "Atatürk İnkılapları", desc: "Siyasal, Toplumsal, Hukuk, Eğitim, Ekonomi" },
            { name: "Atatürk İlkeleri", desc: "Temel ve Bütünleyici İlkeler" },
            { name: "Atatürk Dönemi Türk Dış Politikası", desc: "Milli Dış Politika Gelişmeleri" },
            { name: "Atatürk'ün Hayatı ve Eserleri", desc: "Fikir Hayatı ve Biyografisi" },
            { name: "Çağdaş Türk ve Dünya Tarihi", desc: "II. Dünya Savaşı'ndan Küreselleşmeye" },
            { name: "Denemeler", desc: "Çözülmüş deneme soruları ve analizler" }
        ],
        'cografya': [
            { name: "Türkiye’nin Coğrafi Konumu", desc: "Matematik ve Özel Konum, Kenar Denizler ve Komşular" },
            { name: "Türkiye’nin Yerşekilleri", desc: "Dağlar, Ovalar, Platolar ve Akarsuların Oluşumu" },
            { name: "Türkiye’nin Dış Kuvvetleri", desc: "Rüzgar, Buzul, Dalga ve Akarsu Aşındırması" },
            { name: "Türkiye’nin İklimi ve Bitki Örtüsü", desc: "Sıcaklık, Basınç, Nem ve Yağış Tipleri" },
            { name: "Türkiye’de Toprak Tipleri ve Kullanımı", desc: "Toprak Coğrafyası" },
            { name: "Türkiye’de Doğal Afetler", desc: "Doğal Afet Tipleri ve Korunma Yolları" },
            { name: "Türkiye’nin Beşeri Coğrafyası", desc: "Nüfusun Yapısı, Dağılışı ve Göçler" },
            { name: "Türkiye’de Yerleşme Tipleri", desc: "Köy, Kent ve Köy Altı Yerleşmeleri" },
            { name: "Türkiye’de Tarım", desc: "Tarım Ürünleri ve Uygulanan Yöntemler" },
            { name: "Türkiye’de Hayvancılık", desc: "Küçükbaş, Büyükbaş, Kümes ve Arıcılık" },
            { name: "Türkiye’de Madenler ve Enerji", desc: "Yer Altı Kaynakları" },
            { name: "Türkiye’de Sanayi", desc: "Endüstri Kollarının Dağılımı" },
            { name: "Türkiye’de Ulaşım, Ticaret ve Turizm", desc: "Ekonomik Faaliyetler" },
            { name: "Türkiye’nin Bölgesel Coğrafyası", desc: " Kalkınma Projeleri (GAP, DAP, vb.)" },
            { name: "Denemeler", desc: "Çözülmüş deneme soruları ve analizler" }
        ],
        'anayasa': [
            { name: "Hukukun Temel Kavramları", desc: "Haklar, Fiil Ehliyeti, Borçlar Hukuku vb." },
            { name: "Devlet Biçimleri ve Demokrasi", desc: "Yönetim Şekilleri ve Türler" },
            { name: "Anayasa Tarihi", desc: "1921, 1924, 1961 ve 1982 Anayasaları" },
            { name: "1982 Anayasası’nın İlkeleri", desc: "Anayasal Temeller" },
            { name: "Temel Hak ve Ödevler", desc: "Kişi, Sosyal-Ekonomik ve Siyasi Haklar" },
            { name: "Yasama", desc: "TBMM’nin Yapısı, Seçimler ve Görevleri" },
            { name: "Yürütme", desc: "Cumhurbaşkanının Görevleri ve Teşkilat" },
            { name: "Yargı", desc: "Yüksek Mahkemeler (AYM, Yargıtay, Danıştay)" },
            { name: "İdare Hukuku", desc: "Merkezi ve Yerinden Yönetim" },
            { name: "Kamu Görevlileri", desc: "Özlük Hakları ve Disiplin" },
            { name: "Uluslararası Kuruluşlar", desc: "BM, NATO, AB, Türk Devletleri Teşkilatı" },
            { name: "Güncel Bilgiler", desc: "Kültürel, bilimsel ve siyasi gelişmeler" },
            { name: "Denemeler", desc: "Çözülmüş deneme soruları ve analizler" }
        ]
    };

    const stmt = db.prepare("INSERT INTO topics (subject, name, description, order_index) VALUES (?, ?, ?, ?)");

    for (const [subjectKey, topicList] of Object.entries(subjects)) {
        topicList.forEach((topic, index) => {
            stmt.run([subjectKey, topic.name, topic.desc, index]);
        });
    }

    stmt.free();
    logger.log('Default data populated with descriptions.');
}

function _flushSaveDB() {
    if (!db) return;
    try {
        const data = db.export();
        const arrayData = Array.from(data);
        chrome.storage.local.set({ [DB_CONFIG.dbName]: arrayData });
    } catch (err) {
        logger.error("Critical: Database export failed!", err);
        throw err;
    }
}

export function saveDB(immediate = false) {
    if (!db) return;
    if (suppressSave) {
        pendingSave = true;
        return;
    }
    if (immediate) {
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
        }
        _flushSaveDB();
        return;
    }
    if (saveDebounceTimer) return;
    saveDebounceTimer = setTimeout(() => {
        saveDebounceTimer = null;
        _flushSaveDB();
    }, SAVE_DEBOUNCE_MS);
}

// Sidepanel kapatılırken / sayfa unload olurken bekleyen tüm kayıtları hemen yaz
window.addEventListener('beforeunload', () => {
    saveDB(true);
});

// DATA ACCESS METHODS

export function getTopics(subject) {
    if (!db) return [];
    const stmt = db.prepare("SELECT * FROM topics WHERE subject = ? ORDER BY order_index ASC");
    stmt.bind([subject]);

    const topics = [];
    while (stmt.step()) {
        topics.push(stmt.getAsObject());
    }
    stmt.free();
    return topics;
}

export function toggleTopicStatus(id, currentStatus) {
    const newStatus = currentStatus === 2 ? 0 : 2;
    db.run("UPDATE topics SET status = ? WHERE id = ?", [newStatus, id]);
    saveDB();
    return newStatus;
}

export function addTopic(subject, name, description = "") {
    if (!db) return;
    // Get highest order_index - FIXED: Using prepared statement to prevent SQL injection
    const stmt = db.prepare("SELECT MAX(order_index) FROM topics WHERE subject = ?");
    stmt.bind([subject]);
    let maxOrder = 0;
    if (stmt.step()) {
        const result = stmt.getAsObject();
        maxOrder = result['MAX(order_index)'] || 0;
    }
    stmt.free();

    db.run("INSERT INTO topics (subject, name, description, order_index) VALUES (?, ?, ?, ?)", [subject, name, description, maxOrder + 1]);
    saveDB();

    // Return newest ID
    const idRes = db.exec("SELECT last_insert_rowid()");
    return idRes[0].values[0][0];
}

export function deleteTopic(id) {
    if (!db) return;
    db.run("DELETE FROM topics WHERE id = ?", [id]);
    saveDB();
}

export function updateTopicOrder(subject, orderedIds) {
    if (!db) return;
    orderedIds.forEach((id, index) => {
        db.run("UPDATE topics SET order_index = ? WHERE id = ?", [index, id]);
    });
    saveDB();
}

export function getProgress(subject) {
    if (!db) return { total: 0, completed: 0, percentage: 0 };

    // FIXED: Using prepared statement to prevent SQL injection
    const stmt = db.prepare(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) as completed
        FROM topics 
        WHERE subject = ?
    `);
    stmt.bind([subject]);

    let total = 0;
    let completed = 0;
    if (stmt.step()) {
        const result = stmt.getAsObject();
        total = result.total || 0;
        completed = result.completed || 0;
    }
    stmt.free();

    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, percentage };
}

// === QUESTIONS & SRS ===

export async function addQuestion(subject, topicId, imageBase64) {
    if (!db) {
        logger.error('addQuestion: Database not initialized');
        throw new Error('Database not initialized');
    }

    try {
        // 1. Save Image to Chrome Storage
        const storageKey = `q_img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await chrome.storage.local.set({ [storageKey]: imageBase64 });

        // 2. Save Metadata to DB
        const now = Date.now();
        db.run(`
            INSERT INTO questions(subject, topic_id, resource_id, image_storage_key, next_review, interval, ease_factor, status, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [subject, topicId && !topicId.toString().startsWith('res_') ? topicId : null, topicId && topicId.toString().startsWith('res_') ? parseInt(topicId.replace('res_', '')) : null, storageKey, now, 0, 2.5, 0, now]);

        saveDB();
    } catch (error) {
        logger.error('Error adding question:', error);
        throw error;
    }
}

export function getDueQuestions(subject = null, topicId = null) {
    if (!db) return [];

    const now = Date.now();
    let query = "SELECT * FROM questions WHERE next_review <= ?";
    const params = [now];

    if (subject) {
        query += " AND subject = ?";
        params.push(subject);
    }

    if (topicId) {
        if (topicId.toString().startsWith('res_')) {
            query += " AND resource_id = ?";
            params.push(parseInt(topicId.replace('res_', '')));
        } else {
            query += " AND topic_id = ?";
            params.push(topicId);
        }
    }

    query += " ORDER BY next_review ASC LIMIT 100"; // Increased batch for "Study All"

    const stmt = db.prepare(query);
    stmt.bind(params);

    const questions = [];
    while (stmt.step()) {
        questions.push(stmt.getAsObject());
    }
    stmt.free();
    return questions;
}

export function getAllQuestions(subject = null, topicId = null) {
    if (!db) return [];

    let query = "SELECT * FROM questions WHERE 1=1";
    const params = [];

    if (subject) {
        query += " AND subject = ?";
        params.push(subject);
    }

    if (topicId) {
        if (topicId.toString().startsWith('res_')) {
            query += " AND resource_id = ?";
            params.push(parseInt(topicId.replace('res_', '')));
        } else {
            query += " AND topic_id = ?";
            params.push(topicId);
        }
    }

    query += " ORDER BY created_at DESC";

    const stmt = db.prepare(query);
    stmt.bind(params);

    const questions = [];
    while (stmt.step()) {
        questions.push(stmt.getAsObject());
    }
    stmt.free();
    return questions;
}

export function getTopicStats(subject) {
    if (!db) return {};

    const now = Date.now();

    // FIXED: Using prepared statement and optimized single query to prevent SQL injection
    const stmt = db.prepare(`
        SELECT 
            topic_id, 
            resource_id, 
            COUNT(*) as total,
            SUM(CASE WHEN next_review <= ? THEN 1 ELSE 0 END) as due
        FROM questions 
        WHERE subject = ?
        GROUP BY topic_id, resource_id
    `);
    stmt.bind([now, subject]);

    const stats = {};
    while (stmt.step()) {
        const row = stmt.getAsObject();
        const id = row.topic_id ? row.topic_id : `res_${row.resource_id}`;
        stats[id] = {
            total: row.total || 0,
            due: row.due || 0
        };
    }
    stmt.free();

    return stats;
}

export function updateQuestionSRS(id, rating) {
    // rating: 1 (Again), 2 (Hard), 3 (Good), 4 (Easy)
    if (!db) return;

    // FIXED: Using prepared statement to prevent SQL injection
    const stmt = db.prepare("SELECT * FROM questions WHERE id = ?");
    stmt.bind([id]);
    if (!stmt.step()) {
        stmt.free();
        return;
    }
    const q = stmt.getAsObject();
    stmt.free();

    // columns: id, subject, topic_id, image_storage_key, next_review, interval, ease_factor, status, created_at
    // status: 0:New, 1:Learning, 2:Review

    let interval = q.interval || 0;
    let ease = q.ease_factor || 2.5;
    let status = q.status || 0;

    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const oneMinute = 60 * 1000;

    // === ANKI SM-2 REFINED LOGIC ===

    if (rating === 1) { // AGAIN
        // Anki logic: Reset interval, move to learning, only reduce ease if it was a graduated card
        if (status === 2) { // Was in Review
            ease = Math.max(1.3, ease - 0.2);
        }
        interval = 0; // Moves to minutes logic
        status = 1; // Learning/Re-learning
    }
    else if (rating === 2) { // HARD
        // Anki logic: 1.2x interval, slightly reduce ease
        if (status === 2) {
            interval = Math.max(1, Math.round(interval * 1.2));
            ease = Math.max(1.3, ease - 0.15);
        } else {
            // New/Learning card - Hard logic is usually just a tiny bit more than Again
            interval = 0; // Still in minutes (handled below)
        }
    }
    else if (rating === 3) { // GOOD
        if (status === 2) { // Graduated
            interval = Math.round(interval * ease);
        } else { // Grading from Learning to Review
            interval = 1; // Graduates to 1 day
            status = 2;
        }
    }
    else if (rating === 4) { // EASY
        if (status === 2) { // Graduated
            interval = Math.round(interval * ease * 1.3);
            ease = Math.min(5.0, ease + 0.15);
        } else {
            interval = 4; // Instant graduation to 4 days
            status = 2;
            ease = Math.min(5.0, ease + 0.15);
        }
    }

    // === INTERVAL CAP ===
    const MAX_INTERVAL = 240; // Approx 8 months (8 * 30 days)
    if (interval > MAX_INTERVAL) {
        interval = MAX_INTERVAL;
    }

    // === CALCULATE NEXT REVIEW TIME ===
    let nextReview;
    if (interval === 0) {
        // Minutes logic for Learning phase
        // Again -> 1m, Hard -> 10m (Simplified Anki)
        const lapseTime = (rating === 1) ? 1 : 10;
        nextReview = now + (lapseTime * oneMinute);
    } else {
        // Days logic
        nextReview = now + (interval * oneDay);
    }

    db.run(`
        UPDATE questions 
        SET next_review = ?, interval = ?, ease_factor = ?, status = ?
    WHERE id = ?
        `, [nextReview, interval, ease, status, id]);

    saveDB();
}

export function deleteQuestion(id, storageKey) {
    if (!db) return;

    // Delete from DB
    db.run("DELETE FROM questions WHERE id = ?", [id]);
    saveDB();

    // Delete from Storage (Async, fire and forget)
    chrome.storage.local.remove(storageKey);
}
// --- TODAY'S TASKS ---

export function addToToday(topicId, subject) {
    if (!db) return;

    // Check if already exists to avoid duplicates
    // Use prepared statement to handle both numeric and string IDs
    const stmt = db.prepare("SELECT id FROM today_tasks WHERE topic_id = ?");
    stmt.bind([topicId]);
    const exists = stmt.step();
    stmt.free();

    if (exists) return;

    db.run("INSERT INTO today_tasks (topic_id, subject) VALUES (?, ?)", [topicId, subject]);
    saveDB();
}

export function getTodayTasks(subject = null) {
    if (!db) return [];

    // Get all today_tasks entries - FIXED: Using prepared statement to prevent SQL injection
    let query = "SELECT id as task_id, topic_id, subject FROM today_tasks";
    const params = [];
    if (subject) {
        query += " WHERE subject = ?";
        params.push(subject);
    }
    query += " ORDER BY created_at ASC";

    const stmt = db.prepare(query);
    if (params.length > 0) {
        stmt.bind(params);
    }
    const result = [];
    while (stmt.step()) {
        result.push(stmt.getAsObject());
    }
    stmt.free();
    const tasks = [];

    // FIXED: result is now an array of objects, not db.exec result
    result.forEach(row => {
        const taskId = row.task_id;
        const topicId = row.topic_id;
        const taskSubject = row.subject;

        // Check if this is a resource or regular topic
        const isResource = topicId && topicId.toString().startsWith('res_');

        let name = 'Unknown';
        let status = 0;

        if (isResource) {
            // Get resource details
            const resourceId = parseInt(topicId.replace('res_', ''));
            const resources = getResources(taskSubject); // Assuming getResources is defined elsewhere
            const resource = resources.find(r => r.id === resourceId);
            if (resource) {
                name = `📄 ${resource.name}`;
                status = resource.status || 0;
            }
        } else {
            // Get topic details
            const topicStmt = db.prepare("SELECT name, status FROM topics WHERE id = ?");
            topicStmt.bind([topicId]);
            if (topicStmt.step()) {
                const topicRow = topicStmt.getAsObject();
                name = topicRow.name;
                status = topicRow.status || 0;
            }
            topicStmt.free();
        }

        tasks.push({
            taskId: taskId,
            topicId: topicId,
            name: name,
            status: status,
            subject: taskSubject
        });
    });

    return tasks;
}

export function removeFromToday(taskId) {
    if (!db) return;
    db.run("DELETE FROM today_tasks WHERE id = ?", [taskId]);
    saveDB();
}

export function clearTodayTasks(subject) {
    if (!db) return;
    db.run("DELETE FROM today_tasks WHERE subject = ?", [subject]);
    saveDB();
}

// --- STUDY NOTES & SESSIONS ---

export async function addStudyNote(subject, topicId, content, imageBase64 = null) {
    if (!db) {
        logger.error('addStudyNote: Database not initialized');
        throw new Error('Database not initialized');
    }

    try {
        let storageKey = null;
        if (imageBase64) {
            storageKey = `note_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            await chrome.storage.local.set({ [storageKey]: imageBase64 });
        }

        const now = Date.now();
        db.run(`
            INSERT INTO notes(subject, topic_id, resource_id, content, image_storage_key, next_review, interval, ease_factor, status, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [subject, topicId && !topicId.toString().startsWith('res_') ? topicId : null, topicId && topicId.toString().startsWith('res_') ? parseInt(topicId.replace('res_', '')) : null, content, storageKey, now, 0, 2.5, 0, now]);
        saveDB();
    } catch (error) {
        logger.error('Error adding study note:', error);
        throw error;
    }
}

export async function addVoiceNote(subject, topicId, audioBase64) {
    if (!db) {
        logger.error("addVoiceNote: DB not initialized");
        throw new Error('Database not initialized');
    }
    logger.log("addVoiceNote called:", { subject, topicId, contentLength: audioBase64?.length });

    const storageKey = `voice_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    try {
        await chrome.storage.local.set({ [storageKey]: audioBase64 });
        logger.log("Audio saved to storage:", storageKey);

        const now = Date.now();
        db.run(`
             INSERT INTO notes(subject, topic_id, resource_id, content, audio_storage_key, next_review, interval, ease_factor, status, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         `, [subject, topicId && !topicId.toString().startsWith('res_') ? topicId : null, topicId && topicId.toString().startsWith('res_') ? parseInt(topicId.replace('res_', '')) : null, '', storageKey, now, 0, 2.5, 0, now]);
        saveDB();
        logger.log("Audio metadata saved to SQL.");
    } catch (err) {
        logger.error("addVoiceNote Error:", err);
        throw err;
    }
}

export function getStudyNotes(topicId) {
    if (!db) return [];

    let query = "SELECT * FROM notes WHERE ";
    const params = [];

    if (topicId && topicId.toString().startsWith('res_')) {
        query += "resource_id = ?";
        params.push(parseInt(topicId.replace('res_', '')));
    } else {
        query += "topic_id = ?";
        params.push(topicId);
    }
    query += " ORDER BY created_at ASC";

    const stmt = db.prepare(query);
    stmt.bind(params);

    const notes = [];
    while (stmt.step()) {
        const row = stmt.getAsObject();
        notes.push({
            id: row.id,
            subject: row.subject,
            topic_id: row.topic_id,
            content: row.content,
            image_storage_key: row.image_storage_key,
            audio_storage_key: row.audio_storage_key,
            next_review: row.next_review,
            interval: row.interval,
            ease_factor: row.ease_factor,
            status: row.status,
            created_at: row.created_at
        });
    }
    stmt.free();
    return notes;
}

export function getSubjectVoiceNotes(subject) {
    if (!db) return [];

    // Use LEFT JOINs to get name from either topics or resources
    const stmt = db.prepare(`
        SELECT 
            notes.*, 
            COALESCE(topics.name, resources.name) as topic_name,
            topics.order_index as topic_order,
            resources.sort_order as resource_order
        FROM notes 
        LEFT JOIN topics ON notes.topic_id = topics.id 
        LEFT JOIN resources ON notes.resource_id = resources.id
        WHERE notes.subject = ? AND notes.audio_storage_key IS NOT NULL 
        ORDER BY 
            CASE WHEN notes.topic_id IS NOT NULL THEN 0 ELSE 1 END ASC,
            COALESCE(topics.order_index, resources.sort_order) ASC, 
            notes.created_at ASC
    `);
    stmt.bind([subject]);

    const notes = [];
    while (stmt.step()) {
        const row = stmt.getAsObject();
        // Determine logical topic name (e.g. add '📄' for resources if desired, or keep raw)
        // For distinct grouping in UI, we might want to distinguish them.
        let name = row.topic_name;
        if (row.resource_id) {
            name = `📄 ${name}`;
        }

        // Fallback: Eğer topic_name NULL ise, topic_id veya resource_id'den konu adını bulmaya çalış
        if (!name) {
            if (row.topic_id) {
                // Try to get topic name directly
                const topicStmt = db.prepare("SELECT name FROM topics WHERE id = ?");
                topicStmt.bind([row.topic_id]);
                if (topicStmt.step()) {
                    const topicRow = topicStmt.getAsObject();
                    name = topicRow.name;
                }
                topicStmt.free();
            } else if (row.resource_id) {
                // Try to get resource name directly
                const resourceStmt = db.prepare("SELECT name FROM resources WHERE id = ?");
                resourceStmt.bind([row.resource_id]);
                if (resourceStmt.step()) {
                    const resourceRow = resourceStmt.getAsObject();
                    name = `📄 ${resourceRow.name}`;
                }
                resourceStmt.free();
            }
        }

        notes.push({
            id: row.id,
            subject: row.subject,
            topicId: row.topic_id || `res_${row.resource_id}`, // standardized ID for UI
            content: row.content,
            imageStorageKey: row.image_storage_key,
            audioStorageKey: row.audio_storage_key,
            nextReview: row.next_review,
            interval: row.interval,
            easeFactor: row.ease_factor,
            status: row.status,
            createdAt: row.created_at,
            topicName: name || 'Bilinmeyen Konu'
        });
    }
    stmt.free();

    return notes;
}

export function saveStudySession(topicId, subject, durationSeconds, solvedQuestions = 0) {
    if (!db) return;

    const isResource = topicId && topicId.toString().startsWith('res_');
    const actualTopicId = isResource ? null : topicId;
    const actualResourceId = isResource ? parseInt(topicId.replace('res_', '')) : null;

    db.run("INSERT INTO study_history (topic_id, resource_id, subject, duration_seconds, solved_questions) VALUES (?, ?, ?, ?, ?)",
        [actualTopicId, actualResourceId, subject, durationSeconds, solvedQuestions]);
    saveDB();
}

export function getTopicStudyStats(topicId) {
    if (!db) return { time: 0, questions: 0 };

    // FIXED: Using prepared statement to prevent SQL injection
    let query = "SELECT SUM(duration_seconds), SUM(solved_questions) FROM study_history WHERE ";
    const params = [];
    if (topicId && topicId.toString().startsWith('res_')) {
        query += "resource_id = ?";
        params.push(parseInt(topicId.replace('res_', '')));
    } else {
        query += "topic_id = ?";
        params.push(topicId);
    }

    const stmt = db.prepare(query);
    stmt.bind(params);
    let time = 0;
    let questions = 0;
    if (stmt.step()) {
        const result = stmt.getAsObject();
        time = result['SUM(duration_seconds)'] || 0;
        questions = result['SUM(solved_questions)'] || 0;
    }
    stmt.free();
    return { time, questions };
}

export function getDailyTotals() {
    if (!db) return { time: 0, questions: 0 };
    const result = db.exec(`
        SELECT SUM(duration_seconds), SUM(solved_questions) 
        FROM study_history 
        WHERE date(created_at) = date('now', 'localtime')
    `);
    if (result.length > 0 && result[0].values[0][0] !== null) {
        return {
            time: result[0].values[0][0],
            questions: result[0].values[0][1] || 0
        };
    }
    return { time: 0, questions: 0 };
}

export function getTodaySubjectStats() {
    if (!db) return {};
    const result = db.exec(`
        SELECT subject, SUM(duration_seconds), SUM(solved_questions)
        FROM study_history
        WHERE date(created_at) = date('now', 'localtime')
        GROUP BY subject
    `);
    const stats = {};
    if (result.length > 0) {
        result[0].values.forEach(row => {
            const subject = row[0];
            stats[subject] = {
                time: row[1] || 0,
                questions: row[2] || 0
            };
        });
    }
    return stats;
}

export function getGlobalTotals() {
    if (!db) return { time: 0, questions: 0 };
    const result = db.exec(`
        SELECT SUM(duration_seconds), SUM(solved_questions) 
        FROM study_history
    `);
    if (result.length > 0 && result[0].values[0][0] !== null) {
        return {
            time: result[0].values[0][0],
            questions: result[0].values[0][1] || 0
        };
    }
    return { time: 0, questions: 0 };
}

export function getSubjectTotalStats(subject) {
    if (!db) return { time: 0, questions: 0 };
    // FIXED: Using prepared statement to prevent SQL injection
    const stmt = db.prepare(`
        SELECT SUM(duration_seconds), SUM(solved_questions)
        FROM study_history
        WHERE subject = ?
    `);
    stmt.bind([subject]);
    let time = 0;
    let questions = 0;
    if (stmt.step()) {
        const result = stmt.getAsObject();
        time = result['SUM(duration_seconds)'] || 0;
        questions = result['SUM(solved_questions)'] || 0;
    }
    stmt.free();
    return { time, questions };
}

export function getTopicTodayStats(topicId) {
    if (!db) return { time: 0, questions: 0 };

    // FIXED: Using prepared statement to prevent SQL injection
    let query = "SELECT SUM(duration_seconds), SUM(solved_questions) FROM study_history WHERE ";
    const params = [];
    if (topicId && topicId.toString().startsWith('res_')) {
        query += "resource_id = ?";
        params.push(parseInt(topicId.replace('res_', '')));
    } else {
        query += "topic_id = ?";
        params.push(topicId);
    }
    query += " AND date(created_at) = date('now', 'localtime')";

    const stmt = db.prepare(query);
    stmt.bind(params);
    let time = 0;
    let questions = 0;
    if (stmt.step()) {
        const result = stmt.getAsObject();
        time = result['SUM(duration_seconds)'] || 0;
        questions = result['SUM(solved_questions)'] || 0;
    }
    stmt.free();
    return { time, questions };
}

export function deleteNote(id, storageKey) {
    if (!db) return;
    db.run("DELETE FROM notes WHERE id = ?", [id]);
    saveDB();
    if (storageKey) {
        chrome.storage.local.remove(storageKey);
    }
}

export function getTopicNoteStats(subject) {
    if (!db) return {};
    const now = Date.now();
    // FIXED: Using prepared statement and optimized single query to prevent SQL injection
    // Ses kayıtlarını hariç tut (sadece metin ve görsel notlar)
    const stmt = db.prepare(`
        SELECT 
            topic_id, 
            resource_id, 
            COUNT(*) as total,
            SUM(CASE WHEN audio_storage_key IS NOT NULL THEN 1 ELSE 0 END) as audio_count,
            SUM(CASE WHEN next_review <= ? AND audio_storage_key IS NULL THEN 1 ELSE 0 END) as due
        FROM notes 
        WHERE subject = ? AND audio_storage_key IS NULL
        GROUP BY topic_id, resource_id
    `);
    stmt.bind([now, subject]);

    const stats = {};
    while (stmt.step()) {
        const row = stmt.getAsObject();
        const id = row.topic_id !== null ? row.topic_id : `res_${row.resource_id}`;
        stats[id] = {
            total: row.total || 0,
            audio: row.audio_count || 0,
            due: row.due || 0
        };
    }
    stmt.free();
    return stats;
}

export function getDueNotes(subject = null, topicId = null) {
    if (!db) return [];
    const now = Date.now();
    // Ses kayıtlarını hariç tut (sadece metin ve görsel notlar)
    let query = "SELECT * FROM notes WHERE next_review <= ? AND audio_storage_key IS NULL";
    const params = [now];

    if (subject) { query += " AND subject = ?"; params.push(subject); }
    if (topicId) {
        if (topicId.toString().startsWith('res_')) {
            query += " AND resource_id = ?";
            params.push(parseInt(topicId.replace('res_', '')));
        } else {
            query += " AND topic_id = ?";
            params.push(topicId);
        }
    }

    const stmt = db.prepare(query);
    stmt.bind(params);
    const notes = [];
    while (stmt.step()) notes.push(stmt.getAsObject());
    stmt.free();
    return notes;
}

export function updateNoteSRS(id, rating) {
    if (!db) return;

    // FIXED: Using prepared statement to prevent SQL injection
    const stmt = db.prepare("SELECT * FROM notes WHERE id = ?");
    stmt.bind([id]);
    if (!stmt.step()) {
        stmt.free();
        return;
    }
    const q = stmt.getAsObject();
    stmt.free();
    // id, subject, topic_id, content, image_key, audio_key, next_review, interval, ease, status, created_at
    let interval = q.interval || 0;
    let ease = q.ease_factor || 2.5;
    let status = q.status || 0;

    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const oneMinute = 60 * 1000;

    if (rating === 1) { // AGAIN
        if (status === 2) ease = Math.max(1.3, ease - 0.2);
        interval = 0; status = 1;
    }
    else if (rating === 2) { // HARD
        if (status === 2) {
            interval = Math.max(1, Math.round(interval * 1.2));
            ease = Math.max(1.3, ease - 0.15);
        } else { interval = 0; }
    }
    else if (rating === 3) { // GOOD
        if (status === 2) { interval = Math.round(interval * ease); }
        else { interval = 1; status = 2; }
    }
    else if (rating === 4) { // EASY
        if (status === 2) {
            interval = Math.round(interval * ease * 1.3);
            ease = Math.min(5.0, ease + 0.15);
        } else {
            interval = 4; status = 2;
            ease = Math.min(5.0, ease + 0.15);
        }
    }

    const MAX_INTERVAL = 240;
    if (interval > MAX_INTERVAL) interval = MAX_INTERVAL;

    let nextReview;
    if (interval === 0) {
        const lapseTime = (rating === 1) ? 1 : 10;
        nextReview = now + (lapseTime * oneMinute);
    } else {
        nextReview = now + (interval * oneDay);
    }

    db.run(`
        UPDATE notes 
        SET next_review = ?, interval = ?, ease_factor = ?, status = ?
        WHERE id = ?
    `, [nextReview, interval, ease, status, id]);

    saveDB();
}

// --- TRIALS ---

export function addTrial(data) {
    if (!db) return;
    db.run(`
        INSERT INTO trials (
            type, turkish_d, turkish_y, math_d, math_y, 
            history_d, history_y, geography_d, geography_y, 
            constitution_d, constitution_y, total_net, score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        data.type, data.trD, data.trY, data.matD, data.matY,
        data.tarD, data.tarY, data.cogD, data.cogY,
        data.anaD, data.anaY, data.totalNet, data.score
    ]);
    saveDB();
}

export function getTrials() {
    if (!db) return [];
    const res = db.exec("SELECT * FROM trials ORDER BY created_at DESC");
    const trials = [];
    if (res.length > 0) {
        res[0].values.forEach(row => {
            trials.push({
                id: row[0], type: row[1],
                trD: row[2], trY: row[3],
                matD: row[4], matY: row[5],
                tarD: row[6], tarY: row[7],
                cogD: row[8], cogY: row[9],
                anaD: row[10], anaY: row[11],
                totalNet: row[12], score: row[13],
                created_at: row[14]
            });
        });
    }
    return trials;
}

export function deleteTrial(id) {
    if (!db) return;
    db.run("DELETE FROM trials WHERE id = ?", [id]);
    saveDB();
}

// --- RESOURCES ---

export function addResource(subject, name, type, note = '', status = 0) {
    if (!db) return null;

    // Explicitly handle insertion to ensure we get a fresh ID
    db.run("INSERT INTO resources (subject, name, type, note, status) VALUES (?, ?, ?, ?, ?)",
        [subject, name, type, note, status]);

    const res = db.exec("SELECT last_insert_rowid() as id");
    const newId = Number(res[0].values[0][0]);

    saveDB(); // Save after ID is retrieved
    return newId;
}

export function updateResource(id, name, type, note, status) {
    if (!db) return;
    db.run("UPDATE resources SET name = ?, type = ?, note = ?, status = ? WHERE id = ?", [name, type, note, status, id]);
    saveDB();
}

export function updateResourceLastPage(id, lastPage) {
    if (!db) return;
    db.run("UPDATE resources SET last_page = ? WHERE id = ?", [lastPage, id]);
    saveDB();
}

export function getResources(subject) {
    if (!db) return [];
    const stmt = db.prepare("SELECT * FROM resources WHERE subject = ? ORDER BY status ASC, sort_order ASC, created_at DESC");
    stmt.bind([subject]);

    const resources = [];
    while (stmt.step()) {
        const row = stmt.getAsObject();
        resources.push({
            id: row.id,
            subject: row.subject,
            name: row.name,
            type: row.type,
            note: row.note,
            status: row.status,
            sort_order: row.sort_order,
            pdf_storage_key: row.pdf_storage_key,
            last_page: row.last_page
        });
    }
    stmt.free();
    return resources;
}

export function deleteResource(id) {
    if (!db) return;
    db.run("DELETE FROM resources WHERE id = ?", [id]);
    saveDB();
}

// Get single resource by id (without subject filter)
export function getResourceById(id) {
    if (!db) return null;
    const stmt = db.prepare("SELECT * FROM resources WHERE id = ?");
    stmt.bind([id]);
    let resource = null;
    if (stmt.step()) {
        resource = stmt.getAsObject();
    }
    stmt.free();
    return resource;
}

export function updateResourceOrder(subject, orderedIds) {
    if (!db) return;
    orderedIds.forEach((id, index) => {
        db.run("UPDATE resources SET sort_order = ? WHERE id = ?", [index, id]);
    });
    saveDB();
}
// === PDF & ANNOTATIONS ===

// IndexedDB Helper for Large Blobs
export const IDB_CONFIG = {
    name: 'KPSS_PDF_Store',
    version: 2,
    store: 'pdfs'
};

function openPDFDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_CONFIG.name, IDB_CONFIG.version);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_CONFIG.store)) {
                db.createObjectStore(IDB_CONFIG.store);
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function savePDFToIDB(key, blobData) {
    // Boyut uyarısı (base64 ~50MB = ~37MB raw)
    if (blobData && blobData.length > 52_000_000) {
        logger.warn(`[IDB] Large PDF: ${(blobData.length / 1_000_000).toFixed(1)}MB base64`);
    }
    const idb = await openPDFDB();
    return new Promise((resolve, reject) => {
        let tx;
        try {
            tx = idb.transaction(IDB_CONFIG.store, 'readwrite');
        } catch (e) {
            return reject(e);
        }
        // tx.oncomplete — iOS Safari da dahil tüm tarayıcılarda
        // transaction gerçekten diske yazıldıktan sonra tetiklenir.
        tx.oncomplete = () => resolve();
        tx.onerror   = () => reject(tx.error);
        tx.onabort   = () => reject(tx.error || new Error('IDB transaction aborted'));

        const store = tx.objectStore(IDB_CONFIG.store);
        const req = store.put(blobData, key);
        req.onerror = () => {
            // req hatası transaction'ı otomatik abort eder → tx.onabort üstlenir
            logger.error('[IDB] put error:', req.error);
        };
    });
}

async function getPDFFromIDB(key) {
    const db = await openPDFDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_CONFIG.store, 'readonly');
        const store = tx.objectStore(IDB_CONFIG.store);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function saveResourcePDF(resourceId, pdfBase64) {
    if (!db || !resourceId || !pdfBase64) {
        logger.error("saveResourcePDF: Invalid arguments", { resourceId, hasPDF: !!pdfBase64 });
        return false;
    }
    const storageKey = `res_pdf_${resourceId}`;

    try {
        // 1. Save to IndexedDB (asynchronous)
        await savePDFToIDB(storageKey, pdfBase64);

        // 2. Update SQL Metadata (synchronous memory update)
        // Use prepared statement to ensure ID is tracked correctly
        const stmt = db.prepare("UPDATE resources SET pdf_storage_key = ? WHERE id = ?");
        stmt.run([storageKey, resourceId]);
        stmt.free();

        // 3. Persist memory to storage (asynchronous)
        saveDB();

        logger.log(`PDF saved for resource ${resourceId} with key ${storageKey}`);
        return true;
    } catch (e) {
        logger.error("IDB or SQL Save Failed for PDF:", e);
        // Hata nedenini kaynak yöneticisine ilet (opsiyonel)
        const errName = e && (e.name || e.message || String(e));
        if (errName && errName.toLowerCase().includes('quota')) {
            logger.warn('[PDF] QuotaExceededError — depolama alanı dolu');
            saveResourcePDF._lastError = 'quota';
        } else {
            saveResourcePDF._lastError = errName || 'unknown';
        }
        return false;
    }
}

export async function getResourcePDF(resourceId) {
    if (!db) return null;
    // FIXED: Using prepared statement to prevent SQL injection
    const stmt = db.prepare("SELECT pdf_storage_key FROM resources WHERE id = ?");
    stmt.bind([resourceId]);
    let key = null;
    if (stmt.step()) {
        const result = stmt.getAsObject();
        key = result.pdf_storage_key;
    }
    stmt.free();

    if (key) {
        try {
            return await getPDFFromIDB(key);
        } catch (e) {
            logger.error("IDB Read Failed, trying storage.local", e);
            const data = await chrome.storage.local.get(key);
            return data[key];
        }
    }
    return null;
}


export async function savePageAnnotation(resourceId, pageNum, canvasData) {
    if (!db) return;

    // FIXED: Using prepared statement to prevent SQL injection
    const checkStmt = db.prepare("SELECT id FROM resource_annotations WHERE resource_id = ? AND page_number = ?");
    checkStmt.bind([resourceId, pageNum]);
    const exists = checkStmt.step();
    checkStmt.free();

    if (exists) {
        db.run("UPDATE resource_annotations SET canvas_data = ? WHERE resource_id = ? AND page_number = ?", [canvasData, resourceId, pageNum]);
    } else {
        db.run("INSERT INTO resource_annotations (resource_id, page_number, canvas_data) VALUES (?, ?, ?)", [resourceId, pageNum, canvasData]);
    }
    saveDB();
}

export function getPageAnnotation(resourceId, pageNum) {
    if (!db) return null;
    // FIXED: Using prepared statement to prevent SQL injection
    const stmt = db.prepare("SELECT canvas_data FROM resource_annotations WHERE resource_id = ? AND page_number = ?");
    stmt.bind([resourceId, pageNum]);
    let canvasData = null;
    if (stmt.step()) {
        const result = stmt.getAsObject();
        canvasData = result.canvas_data;
    }
    stmt.free();
    return canvasData;
}

// === HABITS ===

export function addHabit(name, targetCount = 1) {
    if (!db) return null;
    const today = new Date().toISOString().split('T')[0];
    // Get max order_index and add 1 for new habit
    const stmt = db.prepare("SELECT MAX(order_index) as max_order FROM habits");
    let maxOrder = 0;
    if (stmt.step()) {
        const result = stmt.getAsObject();
        maxOrder = (result.max_order || 0) + 1;
    }
    stmt.free();
    
    db.run("INSERT INTO habits (name, target_count, current_count, last_reset_date, order_index) VALUES (?, ?, 0, ?, ?)", 
        [name, targetCount, today, maxOrder]);
    saveDB();
    const res = db.exec("SELECT last_insert_rowid()");
    return res[0].values[0][0];
}

export function getAllHabits() {
    if (!db) return [];
    // Completed habits (current_count >= target_count) should be at the bottom
    // Non-completed habits keep their order_index order
    const stmt = db.prepare(`
        SELECT *, 
               CASE WHEN current_count >= target_count THEN 1 ELSE 0 END as is_completed
        FROM habits 
        ORDER BY is_completed ASC, order_index ASC, created_at DESC
    `);
    const habits = [];
    while (stmt.step()) {
        const habit = stmt.getAsObject();
        delete habit.is_completed; // Remove temporary field
        habits.push(habit);
    }
    stmt.free();
    return habits;
}

export function updateHabitOrder(orderedIds) {
    if (!db) return;
    orderedIds.forEach((id, index) => {
        db.run("UPDATE habits SET order_index = ? WHERE id = ?", [index, id]);
    });
    saveDB();
}

export function moveHabitUp(habitId) {
    if (!db) return false;
    const habits = getAllHabits();
    const currentIndex = habits.findIndex(h => h.id === habitId);
    if (currentIndex <= 0) return false; // Already at top
    
    // Swap with previous
    const prevHabit = habits[currentIndex - 1];
    const currentHabit = habits[currentIndex];
    
    db.run("UPDATE habits SET order_index = ? WHERE id = ?", [currentIndex - 1, currentHabit.id]);
    db.run("UPDATE habits SET order_index = ? WHERE id = ?", [currentIndex, prevHabit.id]);
    saveDB();
    return true;
}

export function moveHabitDown(habitId) {
    if (!db) return false;
    const habits = getAllHabits();
    const currentIndex = habits.findIndex(h => h.id === habitId);
    if (currentIndex < 0 || currentIndex >= habits.length - 1) return false; // Already at bottom
    
    // Swap with next
    const nextHabit = habits[currentIndex + 1];
    const currentHabit = habits[currentIndex];
    
    db.run("UPDATE habits SET order_index = ? WHERE id = ?", [currentIndex + 1, currentHabit.id]);
    db.run("UPDATE habits SET order_index = ? WHERE id = ?", [currentIndex, nextHabit.id]);
    saveDB();
    return true;
}

export function getHabitById(habitId) {
    if (!db) return null;
    const stmt = db.prepare("SELECT * FROM habits WHERE id = ?");
    stmt.bind([habitId]);
    let habit = null;
    if (stmt.step()) {
        habit = stmt.getAsObject();
    }
    stmt.free();
    return habit;
}

export function updateHabitCount(habitId, newCount) {
    if (!db) return;
    db.run("UPDATE habits SET current_count = ? WHERE id = ?", [newCount, habitId]);
    saveDB();
}

export function incrementHabitCount(habitId) {
    if (!db) return;
    // Ultra-fast: Get current values, increment, and update in one go
    const stmt = db.prepare("SELECT current_count, target_count FROM habits WHERE id = ?");
    stmt.bind([habitId]);
    if (stmt.step()) {
        const result = stmt.getAsObject();
        const newCount = Math.min(result.current_count + 1, result.target_count);
        db.run("UPDATE habits SET current_count = ? WHERE id = ?", [newCount, habitId]);
        // saveDB()'yi debounce ile çağır (her tıklamada değil, kısa bir süre sonra)
        if (window.habitSaveTimeout) {
            clearTimeout(window.habitSaveTimeout);
        }
        window.habitSaveTimeout = setTimeout(() => {
            saveDB();
            window.habitSaveTimeout = null;
        }, 200); // 200ms debounce - hızlı tıklamalarda sadece son tıklamada kaydet
    }
    stmt.free();
}

export function resetDailyHabits() {
    if (!db) return;
    const today = new Date().toISOString().split('T')[0];
    const stmt = db.prepare("SELECT id, last_reset_date FROM habits");
    const habitsToReset = [];
    while (stmt.step()) {
        const habit = stmt.getAsObject();
        if (habit.last_reset_date !== today) {
            habitsToReset.push(habit.id);
        }
    }
    stmt.free();
    
    if (habitsToReset.length > 0) {
        const updateStmt = db.prepare("UPDATE habits SET current_count = 0, last_reset_date = ? WHERE id = ?");
        habitsToReset.forEach(id => {
            updateStmt.run([today, id]);
        });
        updateStmt.free();
        saveDB();
    }
}

export function deleteHabit(habitId) {
    if (!db) return;
    db.run("DELETE FROM habits WHERE id = ?", [habitId]);
    saveDB();
}
