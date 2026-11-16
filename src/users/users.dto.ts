import { IsArray, IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsString() @MinLength(2, { message: 'Nama minimal 2 karakter' }) @MaxLength(150) fullName: string;
  @IsEmail({}, { message: 'Format email tidak valid' }) email: string;
  @IsOptional() @IsString() @MinLength(8, { message: 'Kata sandi minimal 8 karakter' }) password?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() position?: string;
  @IsOptional() @IsString() departmentId?: string;
  @IsOptional() @IsArray() roleIds?: string[];
  @IsOptional() @IsBoolean() isSuperAdmin?: boolean;
}

export class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(150) fullName?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() position?: string;
  @IsOptional() @IsString() departmentId?: string | null;
  @IsOptional() @IsArray() roleIds?: string[];
  @IsOptional() @IsBoolean() isSuperAdmin?: boolean;
  @IsOptional() @IsEnum(['active', 'disabled']) status?: 'active' | 'disabled';
}

export class UpdateMeDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(150) fullName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() position?: string;
}

export class ResetPasswordDto {
  @IsOptional() @IsString() @MinLength(8, { message: 'Kata sandi minimal 8 karakter' }) newPassword?: string;
}
