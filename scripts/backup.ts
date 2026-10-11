import { backup, restore } from "../lib/backup";
const mode = process.argv[2];
const job = mode === "restore" ? (process.argv[3] ? restore(process.argv[3]) : Promise.reject(new Error("Specify backup file; stop HOPS first"))) : backup(process.argv[2]);
job.then(result => { console.log(result || "Восстановление завершено. Перед запуском согласуйте заказы с 1С."); }).catch(error => { console.error(error instanceof Error ? error.message : "Backup failed"); process.exitCode = 1; });
