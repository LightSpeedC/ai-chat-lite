/**
 * 版（src/scripts/20_migrate/）が作るテーブルの名前。
 *
 * store.mjs は形を作らないため、開く前に「揃っているか」を確かめる。その一覧がここにある。
 *
 * 【なぜ store.mjs から出してあるのか】
 * store.mjs は最上位で DB を開いて検査し、揃っていなければ throw する。つまり import した
 * 時点で落ちるため、テストから一覧だけを読むことができない。ここに置けば DB を開かずに読める。
 *
 * 【versions を入れない理由】
 * migrate.mjs 自身が CREATE TABLE IF NOT EXISTS で作る。store.mjs が開くのは版を当てた後
 * なので、確かめても必ず在る。
 */
export const REQUIRED_TABLES = ['messages', 'cursors', 'connectors', 'archives'];
