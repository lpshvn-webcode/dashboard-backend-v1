/**
 * Нормализует казахстанские номера телефонов в формат +7XXXXXXXXXX
 *
 * Правила:
 * - 7XXXXXXXXXX → +7XXXXXXXXXX
 * - 8XXXXXXXXXX → +7XXXXXXXXXX (заменить 8 на 7)
 * - +7XXXXXXXXXX → +7XXXXXXXXXX (без изменений)
 * - Другие форматы → вернуть как есть
 *
 * @param phone - телефон в любом формате
 * @returns нормализованный телефон
 */
export function normalizePhone(phone: string | undefined | null): string | undefined {
  if (!phone) return undefined;

  // Убираем все кроме цифр
  const digits = phone.replace(/\D/g, '');

  // Если начинается с 8 и длина 11 цифр (казахстанский номер)
  if (digits.startsWith('8') && digits.length === 11) {
    return '+7' + digits.slice(1);
  }

  // Если начинается с 7 и длина 11 цифр
  if (digits.startsWith('7') && digits.length === 11) {
    return '+' + digits;
  }

  // Если длина 10 цифр (без кода страны) → добавляем +7
  if (digits.length === 10) {
    return '+7' + digits;
  }

  // Возвращаем как есть (международные номера или некорректный формат)
  return phone;
}
